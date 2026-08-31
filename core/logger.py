"""
백엔드 중앙 시스템 로깅 모듈 (core/logger.py)
- 백엔드에서 발생하는 에러, 경고, 시스템 수명주기 로그를 중앙 집중식으로 관리
- 메모리 내 링 버퍼(최대 1,000건) 보관
- Eel WebSocket 브리지를 통해 프론트엔드 [📜 시스템 로그] 탭으로 실시간 전파
- Python 미처리 예외(sys.excepthook) 전역 캡처
"""
import sys
import os
import traceback
import datetime
from collections import deque
import eel

# 최근 1,000건의 로그를 메모리에 보관
_log_buffer = deque(maxlen=1000)


def _get_current_time():
    return datetime.datetime.now().strftime("%H:%M:%S")


def _broadcast_to_frontend(log_entry):
    """프론트엔드로 로그 전송 (Eel 연결 시도, 실패 시 무시)"""
    try:
        if hasattr(eel, 'on_backend_log'):
            eel.on_backend_log(
                log_entry['level'],
                log_entry['category'],
                log_entry['message'],
                log_entry.get('details', '')
            )
    except Exception:
        # 프론트엔드가 아직 로드되지 않았거나 연결이 닫힌 경우 무시
        pass


def log_event(level: str, category: str, message: str, details: str = ''):
    """
    시스템 로그 이벤트 기록 및 프론트엔드 전송
    level: 'info' | 'warn' | 'error' | 'success'
    """
    time_str = _get_current_time()
    entry = {
        'id': f"{datetime.datetime.now().timestamp()}_{len(_log_buffer)}",
        'time': time_str,
        'level': level,
        'category': category or 'System',
        'message': str(message or ''),
        'details': str(details or '')
    }
    _log_buffer.append(entry)

    # 표준 콘솔 출력
    print(f"[{time_str}] [{level.upper()}] [{category}] {message}")
    if details:
        print(f"    {details}")

    _broadcast_to_frontend(entry)
    return entry


def log_info(category: str, message: str, details: str = ''):
    return log_event('info', category, message, details)


def log_warn(category: str, message: str, details: str = ''):
    return log_event('warn', category, message, details)


def log_success(category: str, message: str, details: str = ''):
    return log_event('success', category, message, details)


def log_error(category: str, message: str, exc: Exception = None, details: str = ''):
    """
    에러 로그 기록 (Exception 객체 전달 시 트레이스백 자동 추출)
    """
    stack_trace = details
    if exc is not None:
        tb_lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
        extracted_tb = "".join(tb_lines).strip()
        stack_trace = f"{extracted_tb}\n{details}".strip() if details else extracted_tb

    return log_event('error', category, message, stack_trace)


def _global_excepthook(exc_type, exc_value, exc_traceback):
    """Python 전역 미처리 예외 캡처 훅"""
    if issubclass(exc_type, KeyboardInterrupt):
        sys.__excepthook__(exc_type, exc_value, exc_traceback)
        return

    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback)).strip()
    log_error("Uncaught Exception", str(exc_value), details=tb_str)


def setup_logger():
    """전역 예외 핸들러 등록 및 초기화 로그"""
    sys.excepthook = _global_excepthook
    log_info("System", "Utility Toolkit 백엔드 로거가 초기화되었습니다.")


@eel.expose
def get_backend_system_logs():
    """프론트엔드 부팅 시 지금까지 쌓인 백엔드 로그 목록 반환"""
    return list(_log_buffer)
