"""
빠른 실행(Quick Launch) 항목 관리 및 외부 애플리케이션/세션 실행 서비스 모듈
"""
import os
import subprocess
import json
import webbrowser
import eel

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUICK_LAUNCH_FILE = os.path.join(base_dir, 'quick_launch.json')
QUICK_LAUNCH_EXAMPLE_FILE = os.path.join(base_dir, 'quick_launch.example.json')

DEFAULT_QUICK_LAUNCH = [
    {"id": "1", "name": "계산기", "desc": "Windows 기본 계산기", "icon": "🔢", "type": "cmd", "command": "calc.exe"},
    {"id": "2", "name": "메모장", "desc": "간단한 텍스트 편집기", "icon": "📝", "type": "cmd", "command": "notepad.exe"},
    {"id": "3", "name": "작업 관리자", "desc": "프로세스 및 성능 모니터링", "icon": "📊", "type": "cmd", "command": "taskmgr.exe"},
    {"id": "4", "name": "명령 프롬프트", "desc": "CMD 콘솔 창 열기", "icon": "💻", "type": "cmd", "command": "cmd.exe"},
    {"id": "5", "name": "PowerShell", "desc": "파워쉘 콘솔 창 열기", "icon": "🟦", "type": "cmd", "command": "powershell.exe"},
    {"id": "6", "name": "레지스트리 편집기", "desc": "Windows Registry Editor", "icon": "⚙️", "type": "cmd", "command": "regedit.exe"},
    {"id": "7", "name": "SSH 서버 예시", "desc": "원격 SSH 접속 예시", "icon": "🔒", "type": "ssh", "command": "user@192.168.1.100"}
]


@eel.expose
def get_quick_launch_items():
    """저장된 빠른 실행 항목 목록 불러오기 (없으면 example.json 또는 기본값으로 생성)"""
    try:
        if not os.path.exists(QUICK_LAUNCH_FILE):
            # 템플릿 파일이 있으면 템플릿 로드
            initial_data = DEFAULT_QUICK_LAUNCH
            if os.path.exists(QUICK_LAUNCH_EXAMPLE_FILE):
                try:
                    with open(QUICK_LAUNCH_EXAMPLE_FILE, 'r', encoding='utf-8') as ef:
                        initial_data = json.load(ef)
                except Exception:
                    initial_data = DEFAULT_QUICK_LAUNCH

            with open(QUICK_LAUNCH_FILE, 'w', encoding='utf-8') as f:
                json.dump(initial_data, f, ensure_ascii=False, indent=2)
            return {"status": "success", "data": initial_data}
        
        with open(QUICK_LAUNCH_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return {"status": "success", "data": data}
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_QUICK_LAUNCH}


@eel.expose
def save_quick_launch_items(items):
    """빠른 실행 항목 목록 저장하기"""
    try:
        with open(QUICK_LAUNCH_FILE, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        return {"status": "success", "message": "빠른 실행 목록이 저장되었습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def execute_quick_launch_item(item):
    """빠른 실행 항목 실행 (cmd / ssh / url / powershell)"""
    try:
        item_type = item.get("type", "cmd")
        command = item.get("command", "").strip()
        name = item.get("name", "앱")
        
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
    """지정한 Windows 기본 애플리케이션 실행"""
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
    """새로운 CMD 콘솔 창을 열고 SSH 원격 접속 실행"""
    try:
        cmd = f'start cmd.exe /K "ssh {target}"'
        subprocess.Popen(cmd, shell=True)
        return {
            "status": "success",
            "message": f"SSH 접속 터미널을 실행했습니다 (대상: {target})"
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

