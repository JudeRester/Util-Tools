"""
폴더 바로가기 관리 및 SQLite 영속화 / 탐색기 및 터미널 실행 서비스 모듈
"""
import os
import subprocess
import datetime
import eel
from services.db_service import get_db_connection

DEFAULT_SHORTCUTS = [
    {"id": "1", "name": "현재 도구 모음", "title": "현재 도구 모음", "path": ".", "url_or_path": ".", "icon": "📂", "category": "folder", "key_combo": "", "description": ""},
    {"id": "2", "name": "C 드라이브", "title": "C 드라이브", "path": "C:\\", "url_or_path": "C:\\", "icon": "💽", "category": "folder", "key_combo": "", "description": ""}
]


@eel.expose
def get_folder_shortcuts():
    """저장된 폴더 숏컷 목록 불러오기 (SQLite 조회, 없으면 기본값 삽입 후 반환)"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, title, key_combo, url_or_path, category, description, icon, created_at
                FROM shortcuts
                ORDER BY id ASC
            """)
            rows = cursor.fetchall()

            if not rows:
                records = []
                for item in DEFAULT_SHORTCUTS:
                    records.append((
                        item["id"], item["title"], item.get("key_combo", ""),
                        item["url_or_path"], item.get("category", "folder"),
                        item.get("description", ""), item.get("icon", "📁"),
                        datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    ))
                with conn:
                    conn.executemany("""
                        INSERT OR REPLACE INTO shortcuts (
                            id, title, key_combo, url_or_path, category, description, icon, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)
                cursor.execute("""
                    SELECT id, title, key_combo, url_or_path, category, description, icon, created_at
                    FROM shortcuts
                    ORDER BY id ASC
                """)
                rows = cursor.fetchall()

            data = []
            for r in rows:
                title = r["title"] or ""
                path = r["url_or_path"] or ""
                data.append({
                    "id": str(r["id"]),
                    "name": title,
                    "title": title,
                    "path": path,
                    "url_or_path": path,
                    "icon": r["icon"] or "📁",
                    "key_combo": r["key_combo"] or "",
                    "category": r["category"] or "folder",
                    "description": r["description"] or "",
                    "created_at": r["created_at"] or ""
                })
            return {"status": "success", "data": data}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_SHORTCUTS}


@eel.expose
def save_folder_shortcuts(shortcuts):
    """폴더 숏컷 목록 저장하기 (SQLite 트랜잭션 동기화)"""
    try:
        if not isinstance(shortcuts, list):
            return {"status": "error", "message": "유효한 바로가기 목록 형식이 아닙니다."}

        conn = get_db_connection()
        try:
            records = []
            active_ids = []
            for idx, item in enumerate(shortcuts):
                sid = str(item.get("id") or "")
                if not sid:
                    continue
                active_ids.append(sid)
                title = item.get("name") or item.get("title", "") or ""
                path = item.get("path") or item.get("url_or_path", "") or ""
                icon = item.get("icon", "📁") or "📁"
                key_combo = item.get("key_combo", "") or ""
                category = item.get("category", "folder") or "folder"
                description = item.get("description") or item.get("desc", "") or ""
                created_at = item.get("created_at") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                records.append((sid, title, key_combo, path, category, description, icon, created_at))

            with conn:
                if active_ids:
                    placeholders = ",".join("?" for _ in active_ids)
                    conn.execute(f"DELETE FROM shortcuts WHERE id NOT IN ({placeholders})", active_ids)
                else:
                    conn.execute("DELETE FROM shortcuts")

                if records:
                    conn.executemany("""
                        INSERT OR REPLACE INTO shortcuts (
                            id, title, key_combo, url_or_path, category, description, icon, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)

            return {"status": "success", "message": "바로가기 목록이 저장되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def open_directory(path):
    if not path:
        return {"status": "error", "message": "경로가 지정되지 않았습니다."}
    
    target_path = os.path.abspath(path)
    if not os.path.exists(target_path):
        return {"status": "error", "message": f"경로가 존재하지 않습니다: {target_path}"}
        
    try:
        os.startfile(target_path)
        return {"status": "success", "message": f"폴더 열기 성공: {target_path}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def open_terminal_at(path, shell_type="cmd"):
    if not path:
        return {"status": "error", "message": "경로가 지정되지 않았습니다."}
        
    target_path = os.path.abspath(path)
    if not os.path.exists(target_path):
        return {"status": "error", "message": f"경로가 존재하지 않습니다: {target_path}"}
        
    try:
        if shell_type == "powershell":
            subprocess.Popen(f'start powershell.exe -NoExit -Command "Set-Location \\"{target_path}\\""', shell=True)
        else:
            subprocess.Popen(f'start cmd.exe /K "cd /d {target_path}"', shell=True)
        return {"status": "success", "message": f"{shell_type.upper()} 터미널 실행: {target_path}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
