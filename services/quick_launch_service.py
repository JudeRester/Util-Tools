"""
빠른 실행(Quick Launch) 항목 관리 및 SQLite 영속화 / 외부 애플리케이션 실행 서비스 모듈
"""
import os
import subprocess
import webbrowser
import datetime
import eel
from services.db_service import get_db_connection

DEFAULT_QUICK_LAUNCH = [
    {"id": "1", "name": "계산기", "title": "계산기", "desc": "Windows 기본 계산기", "description": "Windows 기본 계산기", "icon": "🔢", "type": "cmd", "category": "cmd", "command": "calc.exe", "path": "calc.exe", "order_index": 0},
    {"id": "2", "name": "메모장", "title": "메모장", "desc": "간단한 텍스트 편집기", "description": "간단한 텍스트 편집기", "icon": "📝", "type": "cmd", "category": "cmd", "command": "notepad.exe", "path": "notepad.exe", "order_index": 1},
    {"id": "3", "name": "작업 관리자", "title": "작업 관리자", "desc": "프로세스 및 성능 모니터링", "description": "프로세스 및 성능 모니터링", "icon": "📊", "type": "cmd", "category": "cmd", "command": "taskmgr.exe", "path": "taskmgr.exe", "order_index": 2},
    {"id": "4", "name": "명령 프롬프트", "title": "명령 프롬프트", "desc": "CMD 콘솔 창 열기", "description": "CMD 콘솔 창 열기", "icon": "💻", "type": "cmd", "category": "cmd", "command": "cmd.exe", "path": "cmd.exe", "order_index": 3},
    {"id": "5", "name": "PowerShell", "title": "PowerShell", "desc": "파워쉘 콘솔 창 열기", "description": "파워쉘 콘솔 창 열기", "icon": "🟦", "type": "cmd", "category": "cmd", "command": "powershell.exe", "path": "powershell.exe", "order_index": 4},
    {"id": "6", "name": "레지스트리 편집기", "title": "레지스트리 편집기", "desc": "Windows Registry Editor", "description": "Windows Registry Editor", "icon": "⚙️", "type": "cmd", "category": "cmd", "command": "regedit.exe", "path": "regedit.exe", "order_index": 5},
    {"id": "7", "name": "SSH 서버 예시", "title": "SSH 서버 예시", "desc": "원격 SSH 접속 예시", "description": "원격 SSH 접속 예시", "icon": "🔒", "type": "ssh", "category": "ssh", "command": "user@192.168.1.100", "path": "user@192.168.1.100", "order_index": 6}
]


@eel.expose
def get_quick_launch_items():
    """저장된 빠른 실행 항목 목록 불러오기 (SQLite 조회, 없으면 기본값 삽입 후 반환)"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, title, path, icon, category, description, order_index, created_at
                FROM quick_launch
                ORDER BY order_index ASC, id ASC
            """)
            rows = cursor.fetchall()

            if not rows:
                records = []
                for idx, item in enumerate(DEFAULT_QUICK_LAUNCH):
                    records.append((
                        item["id"], item["title"], item["path"],
                        item.get("icon", "⚡"), item.get("category", "cmd"),
                        item.get("description", ""), item.get("order_index", idx),
                        datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    ))
                with conn:
                    conn.executemany("""
                        INSERT OR REPLACE INTO quick_launch (
                            id, title, path, icon, category, description, order_index, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)
                cursor.execute("""
                    SELECT id, title, path, icon, category, description, order_index, created_at
                    FROM quick_launch
                    ORDER BY order_index ASC, id ASC
                """)
                rows = cursor.fetchall()

            data = []
            for r in rows:
                title = r["title"] or ""
                path = r["path"] or ""
                desc = r["description"] or ""
                cat = r["category"] or "cmd"
                data.append({
                    "id": str(r["id"]),
                    "name": title,
                    "title": title,
                    "desc": desc,
                    "description": desc,
                    "icon": r["icon"] or "⚡",
                    "type": cat,
                    "category": cat,
                    "command": path,
                    "path": path,
                    "order_index": r["order_index"],
                    "created_at": r["created_at"] or ""
                })
            return {"status": "success", "data": data}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_QUICK_LAUNCH}


@eel.expose
def save_quick_launch_items(items):
    """빠른 실행 항목 목록 저장하기 (SQLite 트랜잭션 동기화)"""
    try:
        if not isinstance(items, list):
            return {"status": "error", "message": "유효한 빠른 실행 목록 형식이 아닙니다."}

        conn = get_db_connection()
        try:
            records = []
            active_ids = []
            for idx, item in enumerate(items):
                qid = str(item.get("id") or "")
                if not qid:
                    continue
                active_ids.append(qid)
                title = item.get("name") or item.get("title", "") or ""
                path = item.get("command") or item.get("path", "") or ""
                icon = item.get("icon", "⚡") or "⚡"
                category = item.get("type") or item.get("category", "cmd") or "cmd"
                description = item.get("desc") or item.get("description", "") or ""
                order_index = int(item.get("order_index", idx))
                created_at = item.get("created_at") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                records.append((qid, title, path, icon, category, description, order_index, created_at))

            with conn:
                if active_ids:
                    placeholders = ",".join("?" for _ in active_ids)
                    conn.execute(f"DELETE FROM quick_launch WHERE id NOT IN ({placeholders})", active_ids)
                else:
                    conn.execute("DELETE FROM quick_launch")

                if records:
                    conn.executemany("""
                        INSERT OR REPLACE INTO quick_launch (
                            id, title, path, icon, category, description, order_index, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)

            return {"status": "success", "message": "빠른 실행 목록이 저장되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def execute_quick_launch_item(item):
    try:
        item_type = item.get("type") or item.get("category", "cmd")
        command = (item.get("command") or item.get("path", "")).strip()
        name = item.get("name") or item.get("title", "앱")
        
        if not command:
            return {"status": "error", "message": "실행할 명령어/경로가 비어있습니다."}
            
        if item_type == "ssh":
            cmd = f'start cmd.exe /K "ssh {command}"'
            subprocess.Popen(cmd, shell=True)
            return {"status": "success", "message": f"SSH 접속 실행: ssh {command}"}
        elif item_type == "url":
            webbrowser.open(command)
            return {"status": "success", "message": f"웹 페이지 열기: {command}"}
        elif item_type == "powershell_cmd":
            cmd = f'start powershell.exe -NoExit -Command "{command}"'
            subprocess.Popen(cmd, shell=True)
            return {"status": "success", "message": f"PowerShell 명령 실행: {command}"}
        else:
            if os.path.exists(command) and not command.endswith(('.exe', '.bat', '.cmd', '.ps1')):
                os.startfile(command)
            else:
                subprocess.Popen(command, shell=True)
            return {"status": "success", "message": f"'{name}' 실행 완료 ({command})"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def launch_system_app(app_name):
    app_commands = {
        "calculator": "calc.exe",
        "notepad": "notepad.exe",
        "taskmgr": "taskmgr.exe",
        "cmd": "start cmd.exe",
        "powershell": "start powershell.exe",
        "regedit": "regedit.exe",
    }
    cmd = app_commands.get(app_name)
    if not cmd:
        return {"status": "error", "message": f"알 수 없는 애플리케이션입니다: {app_name}"}

    try:
        subprocess.Popen(cmd, shell=True)
        return {"status": "success", "message": f"{app_name} 실행 명령을 전송했습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def launch_ssh(target="user@192.168.1.100"):
    try:
        cmd = f'start cmd.exe /K "ssh {target}"'
        subprocess.Popen(cmd, shell=True)
        return {
            "status": "success",
            "message": f"SSH 접속 터미널을 실행했습니다 (대상: {target})"
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
