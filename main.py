"""
Utility Toolkit - Application Entry Point (메인 진입점)
"""
import os
import sys
import eel

from core.paths import WEB_DIR, APP_DIR, BUNDLE_DIR

# 1. Eel 초기화
eel.init(WEB_DIR)

# 2. 백엔드 서비스 모듈 등록 (@eel.expose 함수들 바인딩)
import services.db_service
import services.system_service
import services.shortcuts_service
import services.quick_launch_service
import services.generator_service
import services.dialog_service
import services.notes_service
import services.calendar_service
import services.diagram_service
import services.settings_service
import services.backup_service
import services.ai_search_service
import services.csv_service
import services.markdown_service
import services.email_service
import services.mock_data_service

# 3. 코어 트레이 관리자 모듈 로드
from core.tray import TrayManager

# 윈도우 실행 옵션 (크롬 메모리 최적화 및 V8 가비지 컬렉터 활성화)
start_options = {
    'mode': 'chrome',      # 'chrome' -> 'edge' -> 'default'
    'size': (960, 680),    # 창 크기
    'port': 0,             # 임의 포트 자동 할당
    'cmdline_args': [
        '--js-flags=--expose-gc --max-old-space-size=128',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--no-default-browser-check'
    ],
    'close_callback': lambda page, sockets: None  # 창을 닫아도 트레이 상주 유지
}


def main():
    print("🛠️ Utility Toolkit을 시작합니다 (모듈화 아키텍처 / 트레이 상주 모드)...")
    tray_manager = TrayManager(base_dir, start_options)
    tray_manager.start()


if __name__ == '__main__':
    main()
