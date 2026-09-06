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

import socket
import time
import webview
from core.tray import TrayManager
from core.edge_widget import EdgeWidgetManager

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


def discover_available_port(start_port: int = 8000, max_attempts: int = 50) -> int:
    """Eel 및 pywebview 간 통신을 위한 로컬 가용 포트 자동 검색"""
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    raise RuntimeError("가용 로컬 포트를 탐색하지 못했습니다.")


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

        core.logger.log_info("Lifecycle", "[Lifecycle] Utility Toolkit 정상 종료 완료")
    except Exception as ex:
        core.logger.log_error("Lifecycle", f"종료 정리 중 예외 발생: {ex}", exc=ex)


def main():
    # 0. 중복 실행 방지: Windows Named Semaphore 락 획득 검사
    from core.single_instance import get_single_instance
    single_inst = get_single_instance()
    if not single_inst.acquire():
        core.logger.log_warn("Lifecycle", "[Lifecycle] 프로그램이 이미 실행 중입니다. 기존 인스턴스를 활성화하고 프로세스를 종료합니다.")
        single_inst.activate_existing_window()
        sys.exit(0)

    core.logger.log_info("Lifecycle", "[Lifecycle] Utility Toolkit 시작 (하이브리드 아키텍처: Eel + pywebview Edge Widget)")

    # 1. Eel 가용 포트 탐색 및 주입
    assigned_port = discover_available_port(8000, 50)
    start_options['port'] = assigned_port


    # 2. Edge Widget Manager 인스턴스화 및 창 등록
    edge_manager = EdgeWidgetManager()
    edge_manager.create_window(assigned_port)
    edge_manager.start_guard()

    # 3. 통합 종료 핸들러 정의
    def shutdown_all():
        try:
            edge_manager.destroy()
        except Exception:
            pass
        app_cleanup()

    # 4. 백그라운드 트레이 및 Eel 웹서버 시작 (Non-blocking)
    tray_manager = TrayManager(BUNDLE_DIR, start_options, on_exit=shutdown_all)
    tray_manager.start()

    # 5. Eel 서버 포트 바인딩 완료 대기 (최대 3초)
    for _ in range(30):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.1)
                if s.connect_ex(('127.0.0.1', assigned_port)) == 0:
                    break
        except Exception:
            pass
        time.sleep(0.1)

    # 6. 메인 스레드: pywebview GUI 이벤트 루프 실행
    try:
        webview.start(debug=False)
    finally:
        shutdown_all()


if __name__ == '__main__':
    main()

