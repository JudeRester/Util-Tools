"""
OpenCodex (ocx) 및 Codex CLI 세션 연동 서비스 모듈
~/.codex/sqlite/codex-dev.db, state_5.sqlite 및 ~/.codex/sessions/**/*.jsonl을 탐색하여
세션 목록, 실시간 활성 락, 라이브 인스펙터 스트림 및 터미널 창 전환/실행을 제공합니다.
"""

import os
import sys
import json
import glob
import sqlite3
import datetime
import subprocess
import shutil
import ctypes
from ctypes import wintypes

import core.logger
from core.paths import APP_DIR

# Windows 콘솔 및 윈도우 API 임포트
if sys.platform == "win32":
    import msvcrt
    kernel32 = ctypes.windll.kernel32
    user32 = ctypes.windll.user32
    rstrtmgr = ctypes.windll.rstrtmgr
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD

CODEX_DIR = os.path.expanduser("~/.codex")
OPENCODEX_DIR = os.path.expanduser("~/.opencodex")
CODEX_DB_PATH = os.path.join(CODEX_DIR, "sqlite", "codex-dev.db")
CODEX_STATE_DB_PATH = os.path.join(CODEX_DIR, "sqlite", "state_5.sqlite")
CODEX_SESSIONS_DIR = os.path.join(CODEX_DIR, "sessions")
CODEX_LOCKS_DIR = os.path.join(CODEX_DIR, "thread-writer-locks")


def is_opencodex_installed() -> bool:
    """OpenCodex / Codex 설치 여부 확인"""
    return os.path.isdir(CODEX_DIR) or os.path.isdir(OPENCODEX_DIR)


def _get_active_ocx_thread_ids() -> set:
    """
    ~/.codex/thread-writer-locks/*.lock 파일들의 msvcrt.locking 비차단 파일 락 검사로
    현재 머신에서 활성 실행 중인 OpenCodex/Codex thread_id 집합을 5ms 이내로 반환
    """
    active_ids = set()
    if sys.platform != "win32" or not os.path.isdir(CODEX_LOCKS_DIR):
        return active_ids

    try:
        lock_files = os.listdir(CODEX_LOCKS_DIR)
        for f in lock_files:
            if f.endswith(".lock") and not f.startswith("."):
                thread_id = f[:-5]
                fp = os.path.join(CODEX_LOCKS_DIR, f)
                try:
                    fd = os.open(fp, os.O_RDWR)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    os.close(fd)
                except OSError:
                    active_ids.add(thread_id)
    except Exception:
        pass

    return active_ids


def _format_timestamp(ts) -> str:
    """Unix 타임스탬프 또는 ISO 문자열을 사람이 읽기 편한 형식으로 변환"""
    try:
        if isinstance(ts, (int, float)):
            if ts > 1e11:
                ts = ts / 1000.0
            dt = datetime.datetime.fromtimestamp(ts)
            return dt.strftime("%Y-%m-%d %H:%M")
        elif isinstance(ts, str):
            dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        pass
    return str(ts) if ts else "일시 미상"


def _clean_workspace_path(path_str: str) -> str:
    """\\\\?\\D:\\workspace\\... 형식의 긴 경로 접두사를 깔끔한 일반 Windows 경로로 정리"""
    if not path_str:
        return ""
    if path_str.startswith("\\\\?\\"):
        return path_str[4:]
    return path_str


def get_opencodex_sessions(limit: int = 60) -> list:
    """
    ~/.codex/sqlite/codex-dev.db 및 state_5.sqlite로부터 세션 목록을 추출하여
    Util-Tools 통합 세션 객체 규격으로 반환
    """
    if not is_opencodex_installed():
        return []

    active_ids = _get_active_ocx_thread_ids()
    sessions = []
    seen_ids = set()

    # 1. codex-dev.db (local_thread_catalog) 조회 (우선순위 1)
    if os.path.exists(CODEX_DB_PATH):
        try:
            db_uri = f"file:{CODEX_DB_PATH}?mode=ro"
            conn = sqlite3.connect(db_uri, uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row

            cursor = conn.execute("""
                SELECT thread_id, display_title, cwd, source_created_at, source_updated_at,
                       source_kind, git_branch, model_provider
                FROM local_thread_catalog
                ORDER BY source_updated_at DESC
                LIMIT ?
            """, (limit * 2,))

            for row in cursor.fetchall():
                tid = row["thread_id"]
                if not tid or tid in seen_ids:
                    continue
                seen_ids.add(tid)

                cwd = _clean_workspace_path(row["cwd"] or "")
                title = (row["display_title"] or "").strip()
                if not title:
                    title = "제목 없는 OpenCodex 세션"

                created_ts = row["source_created_at"] or 0
                updated_ts = row["source_updated_at"] or created_ts

                sessions.append({
                    "id": tid,
                    "conversation_id": tid,
                    "title": title,
                    "source": "ocx",
                    "source_label": "OpenCodex",
                    "model": row["model_provider"] or "Codex",
                    "workspace_path": cwd,
                    "primary_workspace": cwd,
                    "created_at": datetime.datetime.fromtimestamp(created_ts).isoformat() if created_ts else "",
                    "updated_at": datetime.datetime.fromtimestamp(updated_ts).isoformat() if updated_ts else "",
                    "last_modified": _format_timestamp(updated_ts),
                    "sort_timestamp": float(updated_ts),
                    "step_count": 0,
                    "is_current": (os.path.normpath(cwd).lower() == os.path.normpath(APP_DIR).lower()) if cwd else False,
                    "is_current_workspace": (os.path.normpath(cwd).lower() == os.path.normpath(APP_DIR).lower()) if cwd else False,
                    "is_cli_active": tid in active_ids,
                    "git_branch": row["git_branch"] or ""
                })
            conn.close()
        except Exception as e:
            core.logger.log_event("warn", "ocx", f"codex-dev.db 조회 오류: {e}")

    # 2. state_5.sqlite (threads) 보강 및 누락 세션 추가 (우선순위 2)
    if os.path.exists(CODEX_STATE_DB_PATH):
        try:
            db_uri = f"file:{CODEX_STATE_DB_PATH}?mode=ro"
            conn = sqlite3.connect(db_uri, uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row

            cursor = conn.execute("""
                SELECT id, title, cwd, created_at, updated_at, model, tokens_used, rollout_path, first_user_message
                FROM threads
                ORDER BY updated_at DESC
                LIMIT ?
            """, (limit * 2,))

            session_map = {s["id"]: s for s in sessions}

            for row in cursor.fetchall():
                tid = row["id"]
                if not tid:
                    continue

                if tid in session_map:
                    if row["model"]:
                        session_map[tid]["model"] = row["model"]
                    if row["rollout_path"]:
                        session_map[tid]["rollout_path"] = row["rollout_path"]
                    continue

                if len(sessions) >= limit:
                    continue

                seen_ids.add(tid)
                cwd = _clean_workspace_path(row["cwd"] or "")
                title = (row["title"] or row["first_user_message"] or "").strip()
                if not title:
                    title = "제목 없는 OpenCodex 세션"

                created_ts = row["created_at"] or 0
                updated_ts = row["updated_at"] or created_ts

                new_item = {
                    "id": tid,
                    "conversation_id": tid,
                    "title": title,
                    "source": "ocx",
                    "source_label": "OpenCodex",
                    "model": row["model"] or "Codex",
                    "workspace_path": cwd,
                    "primary_workspace": cwd,
                    "created_at": datetime.datetime.fromtimestamp(created_ts).isoformat() if created_ts else "",
                    "updated_at": datetime.datetime.fromtimestamp(updated_ts).isoformat() if updated_ts else "",
                    "last_modified": _format_timestamp(updated_ts),
                    "sort_timestamp": float(updated_ts),
                    "step_count": 0,
                    "is_current": (os.path.normpath(cwd).lower() == os.path.normpath(APP_DIR).lower()) if cwd else False,
                    "is_current_workspace": (os.path.normpath(cwd).lower() == os.path.normpath(APP_DIR).lower()) if cwd else False,
                    "is_cli_active": tid in active_ids,
                    "rollout_path": row["rollout_path"] or ""
                }
                sessions.append(new_item)
                session_map[tid] = new_item
            conn.close()
        except Exception as e:
            core.logger.log_event("warn", "ocx", f"state_5.sqlite 조회 오류: {e}")

    # 최종 정렬 (최신 수정순)
    sessions.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
    return sessions[:limit]


def _find_rollout_file_for_thread(thread_id: str) -> str:
    """특정 thread_id에 해당하는 ~/.codex/sessions/**/rollout-*.jsonl 파일 검색"""
    if not thread_id or not os.path.isdir(CODEX_SESSIONS_DIR):
        return ""

    pattern = os.path.join(CODEX_SESSIONS_DIR, "**", f"*{thread_id}*.jsonl")
    matches = glob.glob(pattern, recursive=True)
    if matches:
        matches.sort(key=os.path.getmtime, reverse=True)
        return matches[0]

    return ""


def get_opencodex_live_tail(thread_id: str, max_steps: int = 15) -> dict:
    """
    OpenCodex rollout JSONL 파일에서 최신 턴과 스텝을 파싱하여
    인앱 실시간 모니터(Live Inspector) 규격으로 반환
    """
    if not thread_id:
        return {"status": "error", "message": "스레드 ID가 지정되지 않았습니다."}

    rollout_file = _find_rollout_file_for_thread(thread_id)
    if not rollout_file or not os.path.isfile(rollout_file):
        return {
            "status": "success",
            "conversation_id": thread_id,
            "title": "OpenCodex 대화 기록",
            "total_steps": 0,
            "steps": [],
            "status_label": "대기 중 (로그 파일 없음)"
        }

    steps = []
    active_ids = _get_active_ocx_thread_ids()
    is_active = thread_id in active_ids

    try:
        with open(rollout_file, "r", encoding="utf-8", errors="replace") as f:
            step_idx = 0
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except Exception:
                    continue

                etype = event.get("type")
                payload = event.get("payload", {})

                # 1. 유저 메시지 턴
                if etype == "event_msg" and payload.get("type") == "user_message":
                    step_idx += 1
                    msg_text = payload.get("message") or ""
                    steps.append({
                        "step_index": step_idx,
                        "type": "USER_INPUT",
                        "title": "사용자 입력",
                        "content": msg_text[:300] + ("..." if len(msg_text) > 300 else ""),
                        "status": "COMPLETED",
                        "tool_calls": []
                    })

                # 2. 도구 실행 호출
                elif etype == "response_item" and payload.get("type") == "custom_tool_call":
                    step_idx += 1
                    tname = payload.get("name") or "도구 실행"
                    tinput = payload.get("input") or {}
                    steps.append({
                        "step_index": step_idx,
                        "type": "PLANNER_RESPONSE",
                        "title": f"도구 호출: {tname}",
                        "content": json.dumps(tinput, ensure_ascii=False)[:250],
                        "status": "RUNNING" if is_active else "COMPLETED",
                        "tool_calls": [{"name": tname, "args": str(tinput)[:150]}]
                    })

                # 3. 도구 실행 결과
                elif etype == "response_item" and payload.get("type") == "custom_tool_call_output":
                    out_text = str(payload.get("output") or "")
                    if steps and steps[-1].get("status") == "RUNNING":
                        steps[-1]["status"] = "COMPLETED"
                        steps[-1]["output"] = out_text[:200]

                # 4. 어시스턴트 메시지 (사고 과정 또는 답변)
                elif etype == "response_item" and payload.get("type") == "message" and payload.get("role") == "assistant":
                    content_list = payload.get("content") or []
                    text_parts = []
                    for c in content_list:
                        if isinstance(c, dict) and c.get("text"):
                            text_parts.append(c["text"])
                    if text_parts:
                        full_msg = "\n".join(text_parts).strip()
                        step_idx += 1
                        steps.append({
                            "step_index": step_idx,
                            "type": "PLANNER_RESPONSE",
                            "title": "어시스턴트 응답",
                            "content": full_msg[:350] + ("..." if len(full_msg) > 350 else ""),
                            "status": "COMPLETED",
                            "tool_calls": []
                        })
    except Exception as e:
        core.logger.log_event("warn", "ocx", f"rollout 파일 파싱 예외: {e}")

    tail_steps = steps[-max_steps:] if len(steps) > max_steps else steps

    return {
        "status": "success",
        "conversation_id": thread_id,
        "title": f"OpenCodex 세션 (#{thread_id[:8]})",
        "total_steps": len(steps),
        "steps": tail_steps,
        "status_label": "🟢 실행 중" if is_active else "대기 중 (유휴)"
    }


def _bring_window_to_front(target_hwnd: int) -> bool:
    """Alt 키 시뮬레이션 기반 포커스 락 해제 후 창 전면 복원"""
    try:
        SW_RESTORE = 9
        user32.ShowWindow(target_hwnd, SW_RESTORE)

        VK_MENU = 0x12
        KEYEVENTF_KEYUP = 0x0002
        user32.keybd_event(VK_MENU, 0, 0, 0)
        user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)

        foreground_hwnd = user32.GetForegroundWindow()
        cur_thread = kernel32.GetCurrentThreadId()
        fg_thread = user32.GetWindowThreadProcessId(foreground_hwnd, None)
        if fg_thread and cur_thread != fg_thread:
            user32.AttachThreadInput(cur_thread, fg_thread, True)
            user32.SetForegroundWindow(target_hwnd)
            user32.BringWindowToTop(target_hwnd)
            user32.AttachThreadInput(cur_thread, fg_thread, False)
        else:
            user32.SetForegroundWindow(target_hwnd)
            user32.BringWindowToTop(target_hwnd)
        return True
    except Exception:
        return False


def _get_visible_desktop_windows():
    """사용자의 활성 입력 데스크톱의 모든 보이는 창(HWND, PID, Title) 수집"""
    windows = []
    def enum_proc(hwnd, lParam):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                windows.append((hwnd, pid.value, buff.value))
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    hDesk = user32.OpenInputDesktop(0, False, 0x01FF)
    if hDesk:
        try:
            user32.EnumDesktopWindows(hDesk, WNDENUMPROC(enum_proc), 0)
        finally:
            user32.CloseDesktop(hDesk)

    if not windows:
        user32.EnumWindows(WNDENUMPROC(enum_proc), 0)

    return windows


def activate_opencodex_terminal_window(thread_id: str) -> bool:
    """
    OpenCodex 세션이 열려 있는 터미널 창을 찾아 화면 맨 앞으로 전환
    :return: True (성공), False (창 없음)
    """
    if sys.platform != "win32" or not thread_id:
        return False

    short_id = thread_id[:8].lower()
    full_id = thread_id.lower()

    try:
        windows = _get_visible_desktop_windows()

        # [1단계] 타이틀 기반 탐색
        for hwnd, pid, title in windows:
            t_lower = title.lower()
            if short_id in t_lower or full_id in t_lower:
                if _bring_window_to_front(hwnd):
                    core.logger.log_event("info", "ocx", f"세션 타이틀 기반 터미널 창 활성화 성공: #{short_id}")
                    return True

        # [2단계] thread_id.lock 파일 락 여부 검증
        lock_file = os.path.join(CODEX_LOCKS_DIR, f"{thread_id}.lock")
        if not os.path.exists(lock_file):
            return False

        is_locked = False
        try:
            fd = os.open(lock_file, os.O_RDWR)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            os.close(fd)
        except OSError:
            is_locked = True

        if not is_locked:
            return False

        # 락이 잡혀있다면 Windows Terminal 창 검색
        for hwnd, pid, title in windows:
            t_lower = title.lower()
            if any(term in t_lower for term in ("powershell", "terminal", "codex", "ocx", "cmd")):
                if _bring_window_to_front(hwnd):
                    core.logger.log_event("info", "ocx", f"활성 터미널 창 포커스 성공: #{short_id} -> {title}")
                    return True

    except Exception as e:
        core.logger.log_event("warn", "ocx", f"터미널 창 활성화 예외: {e}")

    return False


def launch_opencodex_session(thread_id: str, workspace_path: str = "", force: bool = False) -> dict:
    """
    OpenCodex/Codex 세션의 작업 디렉토리에서 터미널 창을 실행하거나 기존 창으로 전환
    :param thread_id: 재개할 스레드 ID (UUID)
    :param workspace_path: 작업 디렉토리 (CWD)
    :param force: 강제 신규 터미널 실행 여부
    """
    if not thread_id:
        return {"status": "error", "message": "세션 ID가 지정되지 않았습니다."}

    short_id = thread_id[:8]

    # 1. 이미 열려 있는 터미널 창 활성화 시도
    if activate_opencodex_terminal_window(thread_id):
        return {
            "status": "success",
            "activated": True,
            "message": f"이미 열려 있는 OpenCodex 세션 [#{short_id}] 터미널 창으로 전환했습니다."
        }

    # 2. 다른 CLI에서 락을 쥐고 있는 경우 중복 실행 방지 경고
    active_ids = _get_active_ocx_thread_ids()
    if thread_id in active_ids and not force:
        return {
            "status": "warning",
            "already_active": True,
            "message": f"세션 [#{short_id}]은(는) 이미 다른 터미널 CLI에서 실행 중입니다.\n\n[실시간 보기 👁️]로 모니터링하시거나, 기존 터미널을 이용해 주세요."
        }

    # 3. 작업 디렉토리 결정
    target_dir = workspace_path
    if not target_dir or not os.path.isdir(target_dir):
        try:
            db_uri = f"file:{CODEX_DB_PATH}?mode=ro"
            conn = sqlite3.connect(db_uri, uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT cwd FROM local_thread_catalog WHERE thread_id = ?", (thread_id,)).fetchone()
            conn.close()
            if row and row["cwd"]:
                candidate = _clean_workspace_path(row["cwd"])
                if os.path.isdir(candidate):
                    target_dir = candidate
        except Exception:
            pass

    if not target_dir or not os.path.isdir(target_dir):
        target_dir = APP_DIR

    # 4. 신규 터미널 창 실행 (PowerShell 기반 codex resume)
    try:
        ps_cmd = f"Set-Location '{target_dir}'; $Host.UI.RawUI.WindowTitle = 'OpenCodex CLI - #{short_id}'; codex resume {thread_id}"
        cmd_args = ["powershell.exe", "-NoExit", "-Command", ps_cmd]
        subprocess.Popen(
            cmd_args,
            cwd=target_dir,
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0x10)
        )
        core.logger.log_event("info", "ocx", f"신규 OpenCodex 세션 터미널 실행: #{short_id}", f"위치: {target_dir}")
        return {
            "status": "success",
            "activated": False,
            "message": f"OpenCodex 세션 [#{short_id}] 터미널 창을 실행했습니다. (작업 폴더: {target_dir})"
        }
    except Exception as e:
        core.logger.log_event("error", "ocx", f"OpenCodex 터미널 실행 오류: {e}")
        return {
            "status": "error",
            "message": f"터미널 실행 실패: {str(e)}"
        }
