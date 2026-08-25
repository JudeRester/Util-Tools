"""
Utility Toolkit - Application Entry Point (메인 진입점)
"""
import os
import sys
import eel

# 경로 설정
base_dir = os.path.dirname(os.path.abspath(__file__))
if base_dir not in sys.path:
    sys.path.insert(0, base_dir)

web_dir = os.path.join(base_dir, 'web')

# 1. Eel 초기화
eel.init(web_dir)

# 2. 백엔드 서비스 모듈 등록 (@eel.expose 함수들 바인딩)
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

# 3. 코어 트레이 관리자 모듈 로드
from core.tray import TrayManager

# 윈도우 실행 옵션
start_options = {
    'mode': 'chrome',      # 'chrome' -> 'edge' -> 'default'
    'size': (960, 680),    # 창 크기
    'port': 0,             # 임의 포트 자동 할당
    'close_callback': lambda page, sockets: None  # 창을 닫아도 트레이 상주 유지
}


def main():
    print("🛠️ Utility Toolkit을 시작합니다 (모듈화 아키텍처 / 트레이 상주 모드)...")
    tray_manager = TrayManager(base_dir, start_options)
    tray_manager.start()


if __name__ == '__main__':
    main()
