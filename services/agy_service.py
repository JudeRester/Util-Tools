"""
Antigravity CLI (agy) 세션 목록 조회 및 대화형 터미널 연동 서비스 모듈
로컬 agy CLI의 세션 데이터(conversation_summaries.db)를 단순 읽기(Read-Only)하여
선택한 세션의 작업 디렉토리에서 터미널을 즉시 이어 실행합니다.
"""
import os
import re
import json
import time
import shutil
import sqlite3
import threading
import subprocess
import urllib.parse
from datetime import datetime
import eel
from core.paths import APP_DIR
import core.logger
from core.tray import show_tray_notification
from services.settings_service import load_settings_from_file

AGY_DB_PATH = os.path.expanduser(r"~/.gemini/antigravity-cli/conversation_summaries.db")
AGY_ANNOTATIONS_DIR = os.path.expanduser(r"~/.gemini/antigravity-cli/annotations")


def _get_annotated_title(conv_id: str) -> str:
    """
    사용자가 agy CLI에서 /rename 명령으로 지정한 커스텀 세션 명칭을 최우선으로 읽어옵니다.
    (저장 위치: ~/.gemini/antigravity-cli/annotations/<conv_id>.pbtxt)
    """
    if not conv_id:
        return ""
    ann_path = os.path.join(AGY_ANNOTATIONS_DIR, f"{conv_id}.pbtxt")
    if os.path.exists(ann_path):
        try:
            with open(ann_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read().strip()
                m = re.search(r'title:\s*"(.*)"', content)
                if m:
                    val = m.group(1).replace('\\"', '"')
                    val = val.strip('"').strip()
                    if val:
                        return val
        except Exception:
            pass
    return ""

# 알림 감시 대상 세션 캐시 및 스레드 상태 관리
_watched_sessions = {}  # { conversation_id: { "last_step": int, "title": str, "last_time": str } }
_watcher_thread = None
_watcher_running = False
_watcher_lock = threading.Lock()


def is_agy_enabled() -> bool:
    """시스템 설정에서 agy 연동 활성화 여부 확인"""
    try:
        settings = load_settings_from_file()
        return bool(settings.get("enable_agy_integration", False))
    except Exception:
        return False


def _parse_workspace_uri(uri: str) -> str:
    """file:///D:/python 형식의 URI를 Windows 표준 경로(D:\\python)로 파싱합니다."""
    try:
        parsed = urllib.parse.urlparse(uri)
        path = urllib.parse.unquote(parsed.path)
        if path.startswith('/') and len(path) > 2 and path[2] == ':':
            path = path[1:]
        return os.path.normpath(path)
    except Exception:
        return ""


AGY_CONVERSATIONS_DIR = os.path.expanduser(r"~/.gemini/antigravity-cli/conversations")
AGY_BRAIN_DIR = os.path.expanduser(r"~/.gemini/antigravity-cli/brain")


def _parse_session_from_conv_db(cid: str) -> dict:
    """
    conversation_summaries.db에 아직 요약 기록되지 않은 활성/신규 세션을 파일 시스템에서 직접 파싱
    """
    db_path = os.path.join(AGY_CONVERSATIONS_DIR, f"{cid}.db")
    t_path = os.path.join(AGY_BRAIN_DIR, cid, ".system_generated", "logs", "transcript.jsonl")

    if not os.path.exists(db_path) and not os.path.exists(t_path):
        return None

    # 1순위: /rename 커스텀 명칭
    title = _get_annotated_title(cid)

    # 2순위: transcript.jsonl의 첫 번째 사용자 입력 프롬프트 내용
    if not title and os.path.exists(t_path):
        try:
            with open(t_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if '"type":"USER_INPUT"' in line:
                        obj = json.loads(line)
                        c = obj.get("content", "").replace("<USER_REQUEST>", "").replace("</USER_REQUEST>", "").strip()
                        if c:
                            title = c.split("\n")[0][:60].strip()
                            break
        except Exception:
            pass

    if not title:
        title = f"세션 {cid[:8]}"

    steps = 0
    workspace = ""
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
            row = conn.execute("SELECT count(*) FROM steps").fetchone()
            if row:
                steps = row[0]
            blob_row = conn.execute("SELECT data FROM trajectory_metadata_blob WHERE id='main'").fetchone()
            conn.close()
            if blob_row and blob_row[0]:
                decoded = blob_row[0].decode("latin1", errors="ignore")
                idx = decoded.find("file:///")
                if idx != -1:
                    part = decoded[idx + len("file:///"):]
                    clean = ""
                    for ch in part:
                        if ord(ch) < 32 or ch in ('"', "'", '<', '>', '\n', '\r'):
                            break
                        clean += ch
                    workspace = os.path.normpath(urllib.parse.unquote(clean))
        except Exception:
            pass

    mtime = os.path.getmtime(db_path) if os.path.exists(db_path) else 0.0
    if os.path.exists(t_path):
        mtime = max(mtime, os.path.getmtime(t_path))

    return {
        "conversation_id": cid,
        "title": title,
        "step_count": steps,
        "primary_workspace": workspace,
        "sort_timestamp": mtime,
        "last_modified": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M") if mtime else "",
        "status": ""
    }


@eel.expose
def get_agy_environment_status():
    """agy-cli 실행 파일 및 로컬 세션 데이터베이스 존재 여부 확인"""
    cli_path = shutil.which("agy") or ""
    db_exists = os.path.exists(AGY_DB_PATH)
    detected = bool(cli_path or db_exists)

    return {
        "status": "success",
        "detected": detected,
        "cli_path": cli_path,
        "db_exists": db_exists,
        "current_workspace": APP_DIR
    }


@eel.expose
def get_agy_sessions(limit: int = 30, workspace_filter: str = "current"):
    """
    로컬 agy-cli 세션 목록 조회 (Read-Only)
    :param limit: 최대 조회 건수
    :param workspace_filter: 'current' (현재 프로젝트 전용), 'all' (전체 세션)
    """
    if not os.path.exists(AGY_DB_PATH):
        return {
            "status": "success",
            "sessions": [],
            "message": "agy 세션 데이터베이스가 존재하지 않습니다."
        }

    current_norm = os.path.normpath(APP_DIR).lower()
    sessions = []

    try:
        # 안전한 읽기 전용(mode=ro) SQLite 연결
        db_uri = f"file:{AGY_DB_PATH}?mode=ro"
        conn = sqlite3.connect(db_uri, uri=True, timeout=3.0)
        conn.row_factory = sqlite3.Row

        try:
            cursor = conn.cursor()
            # 전체 세션을 가져와 실제 파일 수정 시간 기준으로 최신 정렬
            cursor.execute("""
                SELECT conversation_id, preview, title, step_count, last_modified_time, workspace_uris, status
                FROM conversation_summaries
            """)
            rows = cursor.fetchall()

            for r in rows:
                conv_id = r["conversation_id"] or ""
                # 1순위: 사용자가 agy에서 /rename으로 지정한 커스텀 세션명 (annotations/<id>.pbtxt)
                custom_title = _get_annotated_title(conv_id)
                db_title = (r["title"] or "").strip()
                preview = (r["preview"] or "").strip()
                display_title = custom_title if custom_title else (db_title if db_title else (preview if preview else f"세션 {conv_id[:8]}"))

                # 워크스페이스 파싱
                workspace_paths = []
                primary_workspace = ""
                uris_str = r["workspace_uris"] or "[]"
                try:
                    uris = json.loads(uris_str)
                    if isinstance(uris, list):
                        for u in uris:
                            p = _parse_workspace_uri(u)
                            if p:
                                workspace_paths.append(p)
                    if workspace_paths:
                        primary_workspace = workspace_paths[0]
                except Exception:
                    pass

                # 현재 워크스페이스 일치 여부 판별
                is_current = False
                if primary_workspace:
                    is_current = (os.path.normpath(primary_workspace).lower() == current_norm)

                # 필터링 적용
                if workspace_filter == "current" and not is_current:
                    continue

                step_count = r["step_count"] or 0

                # 실제 물리 파일 (transcript.jsonl 또는 conversations/{id}.db) 최신 타임스탬프 & 스텝 확인
                t_path = os.path.expanduser(rf"~/.gemini/antigravity-cli/brain/{conv_id}/.system_generated/logs/transcript.jsonl")
                c_db_path = os.path.expanduser(rf"~/.gemini/antigravity-cli/conversations/{conv_id}.db")

                sort_ts = 0.0
                real_mtime = None

                if os.path.exists(t_path):
                    real_mtime = os.path.getmtime(t_path)
                    try:
                        with open(t_path, "rb") as f:
                            f.seek(0, os.SEEK_END)
                            size = f.tell()
                            f.seek(max(0, size - 4096))
                            lines = f.readlines()
                            if lines:
                                last_event = json.loads(lines[-1].decode("utf-8", errors="ignore"))
                                actual_step = last_event.get("step_index")
                                if actual_step is not None and actual_step > step_count:
                                    step_count = actual_step
                    except Exception:
                        pass
                elif os.path.exists(c_db_path):
                    real_mtime = os.path.getmtime(c_db_path)

                if real_mtime:
                    sort_ts = real_mtime
                    formatted_time = datetime.fromtimestamp(real_mtime).strftime("%Y-%m-%d %H:%M")
                else:
                    raw_time = r["last_modified_time"] or ""
                    formatted_time = raw_time[:16].replace("T", " ") if len(raw_time) >= 16 else raw_time
                    try:
                        # ISO parse fallback for sorting
                        cleaned_iso = raw_time.split("+")[0].split(".")[0].replace("Z", "")
                        dt = datetime.fromisoformat(cleaned_iso)
                        sort_ts = dt.timestamp()
                    except Exception:
                        sort_ts = 0.0

                sessions.append({
                    "conversation_id": conv_id,
                    "title": display_title,
                    "step_count": step_count,
                    "last_modified": formatted_time,
                    "sort_timestamp": sort_ts,
                    "primary_workspace": primary_workspace,
                    "is_current": is_current,
                    "status": r["status"] or ""
                })

            seen_ids = set(s["conversation_id"] for s in sessions)

            # 2. conversation_summaries.db에 아직 요약 기록되지 않은 활성/신규 세션 보충 스캔
            if os.path.exists(AGY_CONVERSATIONS_DIR):
                try:
                    for f in os.listdir(AGY_CONVERSATIONS_DIR):
                        if not f.endswith(".db"):
                            continue
                        cid = f[:-3]
                        if cid in seen_ids:
                            continue

                        parsed = _parse_session_from_conv_db(cid)
                        if not parsed:
                            continue

                        pw = parsed.get("primary_workspace") or ""
                        is_cur = False
                        if pw:
                            is_cur = (os.path.normpath(pw).lower() == current_norm)

                        if workspace_filter == "current" and not is_cur:
                            continue

                        parsed["is_current"] = is_cur
                        sessions.append(parsed)
                        seen_ids.add(cid)
                except Exception as ex:
                    core.logger.log_event("warn", "agy", f"신규 세션 보충 스캔 예외: {ex}")

            # 실제 최종 수정 시간(sort_timestamp) 기준 최신순 재정렬
            sessions.sort(key=lambda s: s["sort_timestamp"], reverse=True)
            sessions = sessions[:limit]

        finally:
            conn.close()

        return {
            "status": "success",
            "sessions": sessions,
            "count": len(sessions),
            "current_workspace": APP_DIR
        }

    except Exception as e:
        core.logger.log_event("error", "agy", f"세션 목록 조회 오류: {e}")
        return {
            "status": "error",
            "message": f"세션 조회 실패: {str(e)}",
            "sessions": []
        }


@eel.expose
def launch_agy_session(conversation_id: str, workspace_path: str = ""):
    """
    지정한 세션의 작업 폴더에서 새 터미널 창을 열어 agy 대화형 세션 이어하기 실행
    """
    if not conversation_id:
        return {"status": "error", "message": "세션 ID가 지정되지 않았습니다."}

    # 작업 디렉토리 결정
    target_dir = workspace_path
    if not target_dir or not os.path.isdir(target_dir):
        # DB에서 다시 조회 시도
        try:
            db_uri = f"file:{AGY_DB_PATH}?mode=ro"
            conn = sqlite3.connect(db_uri, uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?", (conversation_id,)).fetchone()
            conn.close()
            if row and row["workspace_uris"]:
                uris = json.loads(row["workspace_uris"])
                if uris and isinstance(uris, list):
                    candidate = _parse_workspace_uri(uris[0])
                    if os.path.isdir(candidate):
                        target_dir = candidate
        except Exception:
            pass

    # 파일 기반 신규 세션 fallback
    if not target_dir or not os.path.isdir(target_dir):
        parsed = _parse_session_from_conv_db(conversation_id)
        if parsed and parsed.get("primary_workspace") and os.path.isdir(parsed["primary_workspace"]):
            target_dir = parsed["primary_workspace"]

    if not target_dir or not os.path.isdir(target_dir):
        target_dir = APP_DIR

    # 터미널 실행 명령어 구성 (Windows cmd.exe start 창 분리)
    short_id = conversation_id[:8]
    window_title = f"Antigravity CLI - {short_id}"
    launch_cmd = f'start "{window_title}" /D "{target_dir}" cmd.exe /k "agy --conversation {conversation_id}"'

    try:
        subprocess.Popen(
            ["cmd.exe", "/c", launch_cmd],
            cwd=target_dir,
            shell=True
        )
        core.logger.log_event("info", "agy", f"세션 터미널 실행 성공: {conversation_id}", f"위치: {target_dir}")
        return {
            "status": "success",
            "message": f"세션 [{short_id}] 터미널을 실행했습니다. (작업 폴더: {target_dir})"
        }
    except Exception as e:
        core.logger.log_event("error", "agy", f"터미널 실행 오류: {e}")
        return {
            "status": "error",
            "message": f"터미널 실행 실패: {str(e)}"
        }


# ==============================================================================
# 실시간 세션 완료 감지 및 알림 워커 (Strict Gated by enable_agy_integration)
# ==============================================================================

def _check_session_turn_completed(conv_id: str, row: sqlite3.Row) -> bool:
    """
    transcript.jsonl의 마지막 이벤트를 검사하여 에이전트의 턴이 완료(대기 상태)되었는지 판별
    """
    transcript_path = os.path.expanduser(rf"~/.gemini/antigravity-cli/brain/{conv_id}/.system_generated/logs/transcript.jsonl")
    if os.path.exists(transcript_path):
        try:
            with open(transcript_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 4096))
                lines = f.readlines()
                if lines:
                    last_obj = json.loads(lines[-1].decode("utf-8", errors="ignore"))
                    # 플래너/모델 응답이 DONE 상태이거나 사용자 입력 대기 상태인 경우 완료로 판정
                    if last_obj.get("type") in ("PLANNER_RESPONSE", "USER_INPUT") and last_obj.get("status") in ("DONE", "ERROR"):
                        return True
        except Exception:
            pass

    # DB 컬럼 fallback (not_fully_idle가 0이면 대기 상태)
    try:
        if row and "not_fully_idle" in row.keys() and row["not_fully_idle"] == 0:
            return True
    except Exception:
        pass

    return True


def _watcher_loop():
    """백그라운드 세션 감시 루프 (4초 주기 폴링, 토글 OFF 시 즉시 종료)"""
    global _watcher_running
    while _watcher_running:
        # 1. 토글 활성화 여부 엄격 검사 (토글 꺼지면 스레드 즉시 종료)
        if not is_agy_enabled():
            with _watcher_lock:
                _watched_sessions.clear()
                _watcher_running = False
            break

        # 2. 감시 중인 세션 목록 확인 (없으면 DB 쿼리 0건)
        with _watcher_lock:
            watched_ids = list(_watched_sessions.keys())

        if not watched_ids:
            time.sleep(3.0)
            continue

        # 3. 감시 중인 세션의 DB 변경 감지
        try:
            if os.path.exists(AGY_DB_PATH):
                db_uri = f"file:{AGY_DB_PATH}?mode=ro"
                conn = sqlite3.connect(db_uri, uri=True, timeout=2.0)
                conn.row_factory = sqlite3.Row
                placeholders = ",".join("?" for _ in watched_ids)
                rows = conn.execute(
                    f"SELECT conversation_id, title, preview, step_count, last_modified_time, not_fully_idle FROM conversation_summaries WHERE conversation_id IN ({placeholders})",
                    watched_ids
                ).fetchall()
                conn.close()

                completed_sessions = []
                db_found_ids = set()
                for row in rows:
                    cid = row["conversation_id"]
                    db_found_ids.add(cid)
                    with _watcher_lock:
                        info = _watched_sessions.get(cid)
                    if not info:
                        continue

                    curr_step = row["step_count"] or 0
                    curr_time = row["last_modified_time"] or ""

                    # 스텝이 증가했거나 수정 일시가 변경된 경우
                    if curr_step > info["last_step"] or (curr_time != info["last_time"] and curr_step >= info["last_step"]):
                        if _check_session_turn_completed(cid, row):
                            custom_title = _get_annotated_title(cid)
                            title = custom_title or row["title"] or info.get("title") or "세션"
                            completed_sessions.append({
                                "conversation_id": cid,
                                "title": title,
                                "step_count": curr_step
                            })

                # DB에 아직 없는 신규/활성 세션의 파일 시스템 감시
                missing_from_summary = [w_id for w_id in watched_ids if w_id not in db_found_ids]
                for cid in missing_from_summary:
                    with _watcher_lock:
                        info = _watched_sessions.get(cid)
                    if not info:
                        continue
                    parsed = _parse_session_from_conv_db(cid)
                    if not parsed:
                        continue
                    curr_step = parsed.get("step_count", 0)
                    curr_time = str(parsed.get("sort_timestamp", ""))
                    if curr_step > info["last_step"] or (curr_time and curr_time != info["last_time"]):
                        if _check_session_turn_completed(cid, None):
                            completed_sessions.append({
                                "conversation_id": cid,
                                "title": parsed.get("title", "세션"),
                                "step_count": curr_step
                            })

                # 완료된 세션 알림 전송 및 구독 해제
                for comp in completed_sessions:
                    cid = comp["conversation_id"]
                    with _watcher_lock:
                        if cid in _watched_sessions:
                            del _watched_sessions[cid]

                    # 1) Windows OS 시스템 트레이 알림 전송
                    short_id = cid[:8]
                    show_tray_notification(
                        "🤖 Antigravity CLI 작업 완료",
                        f"[{comp['title'][:30]}] 에이전트 응답이 완료되었습니다. (스텝 {comp['step_count']})"
                    )

                    # 2) 앱 내부 프론트엔드 Eel 이벤트 전송
                    try:
                        eel.on_agy_session_completed(comp)()
                    except Exception:
                        pass

                    core.logger.log_event("info", "agy", f"세션 작업 완료 알림 전송: #{short_id}", f"제목: {comp['title']}")

        except Exception as e:
            core.logger.log_event("error", "agy", f"세션 감시 오류: {e}")

        time.sleep(3.0)


def start_agy_watcher_if_needed():
    """감시 스레드 가동 (설정이 켜져 있을 때만)"""
    global _watcher_thread, _watcher_running
    if not is_agy_enabled():
        return False

    with _watcher_lock:
        if not _watcher_running or _watcher_thread is None or not _watcher_thread.is_alive():
            _watcher_running = True
            _watcher_thread = threading.Thread(target=_watcher_loop, daemon=True, name="AgySessionWatcher")
            _watcher_thread.start()
    return True


def stop_agy_watcher():
    """감시 스레드 완전 종료 및 캐시 초기화"""
    global _watcher_running
    with _watcher_lock:
        _watcher_running = False
        _watched_sessions.clear()


@eel.expose
def toggle_agy_watch_session(conversation_id: str, enabled: bool):
    """특정 세션의 작업 완료 알림 구독 토글 (Strict Gated)"""
    if not is_agy_enabled():
        return {
            "status": "error",
            "message": "Antigravity CLI 연동이 비활성화되어 있습니다.",
            "watched": False
        }

    if not conversation_id:
        return {"status": "error", "message": "세션 ID가 없습니다.", "watched": False}

    with _watcher_lock:
        if not enabled:
            if conversation_id in _watched_sessions:
                del _watched_sessions[conversation_id]
            return {
                "status": "success",
                "watched": False,
                "conversation_id": conversation_id,
                "message": "알림 감시가 해제되었습니다."
            }

        # 구독 활성화: 현재 step_count 및 title 기록
        step_count = 0
        title = ""
        last_time = ""
        try:
            if os.path.exists(AGY_DB_PATH):
                db_uri = f"file:{AGY_DB_PATH}?mode=ro"
                conn = sqlite3.connect(db_uri, uri=True, timeout=2.0)
                conn.row_factory = sqlite3.Row
                row = conn.execute(
                    "SELECT step_count, title, last_modified_time FROM conversation_summaries WHERE conversation_id = ?",
                    (conversation_id,)
                ).fetchone()
                conn.close()
                if row:
                    step_count = row["step_count"] or 0
                    title = row["title"] or ""
                    last_time = row["last_modified_time"] or ""
                else:
                    parsed = _parse_session_from_conv_db(conversation_id)
                    if parsed:
                        step_count = parsed.get("step_count", 0)
                        title = parsed.get("title", "")
                        last_time = str(parsed.get("sort_timestamp", ""))
        except Exception:
            pass

        # 1순위: /rename 커스텀 명칭 반영
        custom_title = _get_annotated_title(conversation_id)
        default_preview = row["preview"] if (row and "preview" in row.keys() and row["preview"]) else "세션"
        final_title = custom_title if custom_title else (title if title else default_preview)

        _watched_sessions[conversation_id] = {
            "last_step": step_count,
            "title": final_title,
            "last_time": last_time
        }

    start_agy_watcher_if_needed()
    short_id = conversation_id[:8]
    return {
        "status": "success",
        "watched": True,
        "conversation_id": conversation_id,
        "message": f"세션 [#{short_id}] 작업 완료 알림을 켰습니다."
    }


@eel.expose
def get_watched_agy_sessions():
    """현재 알림 감시 중인 세션 ID 목록 조회"""
    if not is_agy_enabled():
        return []
    with _watcher_lock:
        return list(_watched_sessions.keys())


@eel.expose
def on_agy_toggle_changed(enabled: bool):
    """시스템 탭에서 토글 변경 시 백엔드 스레드 생명주기 즉시 동기화"""
    if not enabled:
        stop_agy_watcher()
    else:
        start_agy_watcher_if_needed()
    return {"status": "success", "enabled": enabled}

