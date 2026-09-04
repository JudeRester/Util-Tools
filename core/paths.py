"""
core/paths.py - Centralized Path Resolution for PyInstaller Bundled & Development Modes
"""
import os
import sys

def get_app_dir() -> str:
    """
    쓰기 가능한 런타임 사용자 데이터 루트 디렉토리
    - 패키징 배포 모드 (.exe): UtilTools.exe 실행 파일이 위치한 디렉토리
    - 개발 모드 (python main.py): 프로젝트 루트 디렉토리 (D:\\python)
    """
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_bundle_dir() -> str:
    """
    읽기 전용 정적 번들 에셋 루트 디렉토리 (HTML/CSS/JS, AI 모델, 기본 템플릿 등)
    - 패키징 배포 모드 (.exe): sys._MEIPASS 또는 exe 디렉토리
    - 개발 모드 (python main.py): 프로젝트 루트 디렉토리 (D:\\python)
    """
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# 1. 루트 경로 상수
APP_DIR = get_app_dir()
BUNDLE_DIR = get_bundle_dir()

# 2. 읽기 전용 번들 정적 리소스 경로
WEB_DIR = os.path.join(BUNDLE_DIR, "web")
MODELS_DIR = os.path.join(BUNDLE_DIR, "models", "multilingual-e5-small")
ICON_PATH = os.path.join(BUNDLE_DIR, "utiltools.ico")
TEMPLATES_DIR = os.path.join(BUNDLE_DIR, "templates")

# 3. 쓰기 가능한 런타임 사용자 데이터 경로
DATA_DIR = os.path.join(APP_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")
EMAILS_DIR = os.path.join(APP_DIR, "emails")
CALENDAR_CONFIG_PATH = os.path.join(APP_DIR, "calendar_config.json")
CALENDAR_CONFIG_EXAMPLE_PATH = os.path.join(TEMPLATES_DIR, "calendar_config.example.json")
APP_SETTINGS_PATH = os.path.join(APP_DIR, "app_settings.json")
APP_SETTINGS_EXAMPLE_PATH = os.path.join(TEMPLATES_DIR, "app_settings.example.json")
BROWSER_PROFILE_DIR = os.path.join(DATA_DIR, "browser_profile")
