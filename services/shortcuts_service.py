"""
폴더 바로가기 관리, 탐색기 및 터미널 실행 서비스 모듈
"""
import os
import subprocess
import json
import eel

# 설정 파일 경로
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHORTCUTS_FILE = os.path.join(base_dir, 'shortcuts.json')
SHORTCUTS_EXAMPLE_FILE = os.path.join(base_dir, 'shortcuts.example.json')

DEFAULT_SHORTCUTS = [
    {"id": "1", "name": "현재 도구 모음", "path": ".", "icon": "📂"},
    {"id": "2", "name": "C 드라이브", "path": "C:\\", "icon": "💽"}
]


@eel.expose
def get_folder_shortcuts():
    """저장된 폴더 숏컷 목록 불러오기 (없으면 example.json 또는 기본값으로 생성)"""
    try:
        if not os.path.exists(SHORTCUTS_FILE):
            # 템플릿 파일이 있으면 템플릿 로드
            initial_data = DEFAULT_SHORTCUTS
            if os.path.exists(SHORTCUTS_EXAMPLE_FILE):
                try:
                    with open(SHORTCUTS_EXAMPLE_FILE, 'r', encoding='utf-8') as ef:
                        initial_data = json.load(ef)
                except Exception:
                    initial_data = DEFAULT_SHORTCUTS

            with open(SHORTCUTS_FILE, 'w', encoding='utf-8') as f:
                json.dump(initial_data, f, ensure_ascii=False, indent=2)
            return {"status": "success", "data": initial_data}
        
        with open(SHORTCUTS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return {"status": "success", "data": data}
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_SHORTCUTS}


@eel.expose
def save_folder_shortcuts(shortcuts):
    """폴더 숏컷 목록 저장하기"""
    try:
        with open(SHORTCUTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(shortcuts, f, ensure_ascii=False, indent=2)
        return {"status": "success", "message": "바로가기가 저장되었습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def open_directory(path="."):
    """지정한 경로를 윈도우 탐색기로 열기"""
    try:
        target_path = os.path.abspath(path)
        if not os.path.exists(target_path):
            return {"status": "error", "message": f"경로가 존재하지 않습니다: {target_path}"}
        
        os.startfile(target_path)
        return {"status": "success", "message": f"탐색기로 폴더를 열었습니다: {target_path}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def open_terminal_at(path=".", terminal_type="powershell"):
    """지정한 디렉토리 위치에서 PowerShell 또는 CMD 터미널 창을 독립 실행"""
    try:
        target_path = os.path.abspath(path)
        if not os.path.exists(target_path):
            return {"status": "error", "message": f"경로가 존재하지 않습니다: {target_path}"}

        if terminal_type.lower() == "powershell":
            cmd = f'start powershell.exe -NoExit -Command "Set-Location -LiteralPath \'{target_path}\'"'
        else:
            cmd = f'start cmd.exe /K "cd /d \"{target_path}\""'

        subprocess.Popen(cmd, shell=True)
        return {
            "status": "success",
            "message": f"[{terminal_type.upper()}] '{target_path}' 위치에서 터미널을 실행했습니다."
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
