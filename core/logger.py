"""
백엔드 중앙 시스템 로깅 모듈 (core/logger.py)
- 백엔드에서 발생하는 에러, 경고, 시스템 수명주기 로그를 중앙 집중식으로 관리
- 메모리 내 링 버퍼(최대 1,000건) 보관
- Eel WebSocket 브리지를 통해 프론트엔드 [📜 시스템 로그] 탭으로 실시간 전파
- Python 미처리 예외(sys.excepthook) 전역 캡처
"""
import sys
import os
import io
import traceback
import datetime
import threading
from collections import deque
import eel

# 원본 표준 출력/에러 스트림 보존 (재귀 호출 방지 및 터미널 동시 출력용)
_orig_stdout = sys.__stdout__ if sys.__stdout__ is not None else sys.stdout
_orig_stderr = sys.__stderr__ if sys.__stderr__ is not None else sys.stderr

# 최근 1,000건의 로그를 메모리에 보관
_log_buffer = deque(maxlen=1000)

_redirector_stdout = None
_redirector_stderr = None


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

    # 원본 콘솔 출력 (sys.stdout 리디렉션과의 무한 재귀를 방지하기 위해 _orig_stdout 직접 사용)
    if _orig_stdout:
        try:
            out_str = f"[{time_str}] [{level.upper()}] [{category}] {message}\n"
            if details:
                out_str += f"    {details}\n"
            _orig_stdout.write(out_str)
            if hasattr(_orig_stdout, 'flush'):
                _orig_stdout.flush()
        except Exception:
            pass

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


class LogStreamRedirector:
    """
    sys.stdout / sys.stderr 인터셉터
    - 기존 print() 및 서드파티 라이브러리의 표준 출력을 줄 단위로 버퍼링
    - core.logger.log_event()로 자동 수집하여 프론트엔드 시스템 로그로 브로드캐스트
    - 터미널 실행 환경에서는 원본 콘솔 스트림으로도 동시 전달
    """
    def __init__(self, orig_stream, level: str = 'info', default_category: str = 'Console'):
        self._orig_stream = orig_stream
        self._level = level
        self._default_category = default_category
        self._buffer = io.StringIO()
        self._lock = threading.Lock()
        self._local = threading.local()

    def write(self, text):
        if not text:
            return 0

        # 1. 원본 스트림으로 즉시 통과 (터미널 콘솔 출력 유지)
        if self._orig_stream:
            try:
                self._orig_stream.write(text)
                if hasattr(self._orig_stream, 'flush'):
                    self._orig_stream.flush()
            except Exception:
                pass

        # 2. 재진입(Re-entrancy) 방지: 이미 리디렉션 처리 중인 스레드는 중복 로깅 차단
        if getattr(self._local, 'active', False):
            return len(text)

        # 3. 버퍼링 및 개행(\n) 단위 로그 라인 생성
        with self._lock:
            self._local.active = True
            try:
                self._buffer.write(str(text))
                if '\n' in text:
                    content = self._buffer.getvalue()
                    self._buffer.seek(0)
                    self._buffer.truncate(0)
                    for line in content.splitlines():
                        clean_line = line.strip()
                        if not clean_line:
                            continue
                        # [Category] 패턴 자동 추출 (예: [WhisperWorker] 메시지 -> category='WhisperWorker')
                        category = self._default_category
                        msg = clean_line
                        if clean_line.startswith("[") and "]" in clean_line[1:30]:
                            idx = clean_line.index("]")
                            tag = clean_line[1:idx].strip()
                            rest = clean_line[idx + 1:].strip()
                            if tag and rest:
                                category = tag
                                msg = rest

                        log_event(self._level, category, msg)
            finally:
                self._local.active = False

        return len(text)

    def flush(self):
        if self._orig_stream and hasattr(self._orig_stream, 'flush'):
            try:
                self._orig_stream.flush()
            except Exception:
                pass

        with self._lock:
            if not getattr(self._local, 'active', False):
                self._local.active = True
                try:
                    content = self._buffer.getvalue()
                    if content:
                        self._buffer.seek(0)
                        self._buffer.truncate(0)
                        for line in content.splitlines():
                            clean_line = line.strip()
                            if clean_line:
                                log_event(self._level, self._default_category, clean_line)
                finally:
                    self._local.active = False

    def isatty(self):
        return getattr(self._orig_stream, 'isatty', lambda: False)()

    def fileno(self):
        if self._orig_stream and hasattr(self._orig_stream, 'fileno'):
            try:
                return self._orig_stream.fileno()
            except Exception:
                pass
        raise io.UnsupportedOperation("fileno")

    @property
    def encoding(self):
        return getattr(self._orig_stream, 'encoding', 'utf-8') or 'utf-8'

    @property
    def errors(self):
        return getattr(self._orig_stream, 'errors', 'replace') or 'replace'


def _global_excepthook(exc_type, exc_value, exc_traceback):
    """Python 메인 스레드 전역 미처리 예외 캡처 훅"""
    if issubclass(exc_type, KeyboardInterrupt):
        sys.__excepthook__(exc_type, exc_value, exc_traceback)
        return

    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback)).strip()
    log_error("Uncaught Exception", str(exc_value), details=tb_str)


def _thread_excepthook(args):
    """Python 백그라운드 스레드 미처리 예외 캡처 훅 (Python 3.8+)"""
    if issubclass(args.exc_type, KeyboardInterrupt):
        return

    thread_name = args.thread.name if args.thread else "Thread"
    tb_str = "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)).strip()
    log_error(f"Thread:{thread_name}", str(args.exc_value), details=tb_str)


def setup_logger():
    """전역 예외 핸들러 등록, 스트림 리디렉터 장착 및 초기화 로그"""
    global _redirector_stdout, _redirector_stderr

    # 1. UTF-8 인코딩 안전 재설정
    if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
        try:
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    # 2. 표준 출력(sys.stdout) 및 표준 에러(sys.stderr) 스트림 리디렉터 장착
    if _redirector_stdout is None:
        _redirector_stdout = LogStreamRedirector(_orig_stdout, level='info', default_category='Console')
        sys.stdout = _redirector_stdout
    if _redirector_stderr is None:
        _redirector_stderr = LogStreamRedirector(_orig_stderr, level='warn', default_category='Stderr')
        sys.stderr = _redirector_stderr

    # 3. 메인 스레드 전역 미처리 예외 훅 등록
    sys.excepthook = _global_excepthook

    # 4. 백그라운드 스레드 전역 미처리 예외 훅 등록 (Python 3.8+)
    if hasattr(threading, 'excepthook'):
        threading.excepthook = _thread_excepthook

    log_info("System", "Utility Toolkit 백엔드 로깅 파이프라인 초기화 완료")


@eel.expose
def get_backend_system_logs():
    """프론트엔드 부팅 시 지금까지 쌓인 백엔드 로그 목록 반환"""
    return list(_log_buffer)
