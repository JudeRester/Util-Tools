"""
Antigravity CLI (agy) 세션 목록 조회 및 대화형 터미널 연동 서비스 모듈
로컬 agy CLI의 세션 데이터(conversation_summaries.db)를 단순 읽기(Read-Only)하여
선택한 세션의 작업 디렉토리에서 터미널을 즉시 이어 실행합니다.
"""
import os
import json
import shutil
import sqlite3
import subprocess
import urllib.parse
from datetime import datetime
import eel
from core.paths import APP_DIR
import core.logger

AGY_DB_PATH = os.path.expanduser(r"~/.gemini/antigravity-cli/conversation_summaries.db")


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
            # 최근 수정된 세션 순으로 넉넉히 가져온 뒤 필터링
            fetch_limit = limit * 3 if workspace_filter == "current" else limit
            cursor.execute("""
                SELECT conversation_id, preview, title, step_count, last_modified_time, workspace_uris, status
                FROM conversation_summaries
                ORDER BY last_modified_time DESC
                LIMIT ?
            """, (fetch_limit,))
            rows = cursor.fetchall()

            for r in rows:
                conv_id = r["conversation_id"] or ""
                preview = (r["preview"] or "").strip()
                title = (r["title"] or "").strip()
                display_title = preview if preview else (title if title else f"세션 {conv_id[:8]}")

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

                # 날짜 형식 정리 (ISO -> YYYY-MM-DD HH:MM)
                raw_time = r["last_modified_time"] or ""
                formatted_time = raw_time[:16].replace("T", " ") if len(raw_time) >= 16 else raw_time

                sessions.append({
                    "conversation_id": conv_id,
                    "title": display_title,
                    "step_count": r["step_count"] or 0,
                    "last_modified": formatted_time,
                    "primary_workspace": primary_workspace,
                    "is_current": is_current,
                    "status": r["status"] or ""
                })

                if len(sessions) >= limit:
                    break

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
