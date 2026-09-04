"""
Utility Toolkit - Application Entry Point (메인 진입점)
"""
import os
import sys
import eel

from core.paths import WEB_DIR, APP_DIR, BUNDLE_DIR, BROWSER_PROFILE_DIR
import core.logger

# 0. 백엔드 시스템 로거 초기화
core.logger.setup_logger()

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
import services.redmine_service
import services.image_service
import services.agy_service
import services.opencodex_service

# 3. 코어 트레이 관리자 모듈 로드
from core.tray import TrayManager

# 윈도우 실행 옵션 (사용자 기본 브라우저 간섭 방지: 격리 프로파일 및 메모리 최적화)
start_options = {
    'mode': 'chrome',      # 'chrome' -> 'edge' -> 'default'
    'size': (960, 680),    # 창 크기
    'port': 0,             # 임의 포트 자동 할당
    'cmdline_args': [
        f'--user-data-dir={BROWSER_PROFILE_DIR}',
        '--no-first-run',
        '--no-default-browser-check',
        '--js-flags=--expose-gc --max-old-space-size=128',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps'
    ],
    'close_callback': lambda page, sockets: None  # 창을 닫아도 트레이 상주 유지
}


def app_cleanup():
    """애플리케이션 정상 종료 시 리소스 정리 및 SQLite WAL 체크포인트 병합"""
    try:
        from services.db_service import get_db_connection
        from core.paths import DATA_DIR
        import shutil

        # 1. SQLite WAL 체크포인트 강제 실행 (모든 트랜잭션을 본 DB 파일에 병합)
        conn = get_db_connection()
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            conn.commit()
            core.logger.log_info("Lifecycle", "SQLite WAL 체크포인트(TRUNCATE) 완료: app.db 병합됨")
        except Exception as e:
            core.logger.log_error("Lifecycle", f"WAL 체크포인트 오류: {e}", exc=e)
        finally:
            conn.close()

        # 2. 세션 임시 첨부파일 디렉토리 정리
        temp_att_dir = os.path.join(DATA_DIR, "temp_attachments")
        if os.path.exists(temp_att_dir):
            try:
                shutil.rmtree(temp_att_dir, ignore_errors=True)
            except Exception:
                pass

        # 3. 단일 인스턴스 세마포어 해제
        try:
            from core.single_instance import get_single_instance
            get_single_instance().release()
        except Exception:
            pass

        core.logger.log_info("Lifecycle", "🛑 Utility Toolkit이 안전하게 종료되었습니다.")
    except Exception as ex:
        core.logger.log_error("Lifecycle", f"종료 정리 중 예외 발생: {ex}", exc=ex)


def main():
    # 0. 중복 실행 방지: Windows Named Semaphore 락 획득 검사
    from core.single_instance import get_single_instance
    single_inst = get_single_instance()
    if not single_inst.acquire():
        core.logger.log_warn("Lifecycle", "⚠️ 프로그램이 이미 실행 중입니다. 기존 인스턴스를 활성화하고 새 프로세스를 종료합니다.")
        single_inst.activate_existing_window()
        sys.exit(0)

    core.logger.log_info("Lifecycle", "🛠️ Utility Toolkit을 시작합니다 (모듈화 아키텍처 / 트레이 상주 모드)...")
    tray_manager = TrayManager(BUNDLE_DIR, start_options, on_exit=app_cleanup)
    tray_manager.start()


if __name__ == '__main__':
    main()
