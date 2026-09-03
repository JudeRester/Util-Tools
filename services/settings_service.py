import os
import json
import eel
from core.paths import APP_SETTINGS_PATH as SETTINGS_FILE, APP_SETTINGS_EXAMPLE_PATH as EXAMPLE_FILE

DEFAULT_SETTINGS = {
    "active_tab_id": "system",
    "console_height": 180,
    "console_collapsed": False,
    "calendar_month_width": None,
    "notes_sidebar_width": None,
    "js_editor_width": None,
    "enable_agy_integration": False
}

def load_settings_from_file():
    """로컬 app_settings.json 또는 example 템플릿에서 설정을 읽어옵니다."""
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    settings = DEFAULT_SETTINGS.copy()
                    settings.update(data)
                    return settings
        except Exception as e:
            print(f"[SettingsService] Error reading {SETTINGS_FILE}: {e}")

    if os.path.exists(EXAMPLE_FILE):
        try:
            with open(EXAMPLE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    settings = DEFAULT_SETTINGS.copy()
                    settings.update(data)
                    return settings
        except Exception:
            pass

    return DEFAULT_SETTINGS.copy()

def save_settings_to_file(settings_dict):
    """설정을 app_settings.json 파일에 영구 저장합니다."""
    try:
        current = load_settings_from_file()
        current.update(settings_dict)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(current, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[SettingsService] Error saving {SETTINGS_FILE}: {e}")
        return False

@eel.expose
def get_app_settings():
    """프론트엔드로 앱 설정을 반환합니다."""
    settings = load_settings_from_file()
    return {"status": "success", "data": settings}

@eel.expose
def save_app_settings(settings_dict):
    """프론트엔드로부터 전달받은 설정을 파일에 저장합니다."""
    if not isinstance(settings_dict, dict):
        return {"status": "error", "message": "유효하지 않은 설정 데이터입니다."}
    
    success = save_settings_to_file(settings_dict)
    if success:
        return {"status": "success", "message": "설정이 저장되었습니다."}
    else:
        return {"status": "error", "message": "설정 저장에 실패했습니다."}
