"""
Utility Toolkit - Single Instance Lock Manager (단일 인스턴스 세마포어 매니저)
Windows Named Semaphore(커널 동기화 객체)를 활용하여 백그라운드 중복 실행을 원천 차단하고,
중복 실행 시 기존 실행 중인 창을 맨 앞으로 활성화합니다.
"""
import sys
import ctypes

SEMAPHORE_NAME = "Local\\UtilTools_SingleInstance_Semaphore"
ERROR_ALREADY_EXISTS = 183


class SingleInstanceManager:
    """Windows Named Semaphore 기반 단일 인스턴스 락 관리자"""

    def __init__(self, name: str = SEMAPHORE_NAME):
        self.name = name
        self.handle = None
        self.is_already_running = False

    def acquire(self) -> bool:
        """
        세마포어를 생성/획득하여 중복 실행 여부를 판별합니다.
        :return: True - 첫 번째 실행 인스턴스 (정상 진행 가능)
                 False - 이미 백그라운드나 다른 프로세스에서 실행 중임
        """
        if sys.platform != "win32":
            return True

        try:
            kernel32 = ctypes.windll.kernel32
            # 슬롯 1개짜리 Windows 커널 명명된 세마포어 생성
            self.handle = kernel32.CreateSemaphoreW(
                None,  # 기본 보안 디스크립터
                1,     # 초기 카운트
                1,     # 최대 카운트
                self.name
            )

            last_error = kernel32.GetLastError()
            if last_error == ERROR_ALREADY_EXISTS:
                self.is_already_running = True
                if self.handle:
                    kernel32.CloseHandle(self.handle)
                    self.handle = None
                return False

            return True
        except Exception as e:
            # 예외 발생 시 안전하게 단독 실행으로 허용
            print(f"[SingleInstance] 세마포어 초기화 예외: {e}", file=sys.stderr)
            return True

    def activate_existing_window(self):
        """이미 실행 중인 기존 프로세스의 윈도우를 찾아 맨 앞으로 복원/활성화"""
        if sys.platform != "win32":
            return False

        try:
            user32 = ctypes.windll.user32
            # Eel 앱 기본 창 타이틀 탐색
            hwnd = user32.FindWindowW(None, "Utility Toolkit")
            if not hwnd:
                hwnd = user32.FindWindowW(None, "Util-Tools")

            if hwnd:
                SW_RESTORE = 9
                user32.ShowWindow(hwnd, SW_RESTORE)
                user32.SetForegroundWindow(hwnd)
                return True
            else:
                # 창이 트레이에 숨겨져 있거나 백그라운드 상태인 경우 알림창 팝업
                MB_ICONINFORMATION = 0x40
                MB_SETFOREGROUND = 0x10000
                user32.MessageBoxW(
                    0,
                    "Util-Tools가 이미 시스템 트레이(백그라운드)에서 실행 중입니다.\n\n작업 표시줄 우측 하단의 트레이 아이콘(🛠️)을 클릭하여 창을 열 수 있습니다.",
                    "Util-Tools 실행 안내",
                    MB_ICONINFORMATION | MB_SETFOREGROUND
                )
                return True
        except Exception as e:
            print(f"[SingleInstance] 창 활성화 예외: {e}", file=sys.stderr)
            return False

    def release(self):
        """세마포어 핸들 정리"""
        if self.handle and sys.platform == "win32":
            try:
                ctypes.windll.kernel32.CloseHandle(self.handle)
                self.handle = None
            except Exception:
                pass


# 모듈 레벨 전역 단일 인스턴스 객체
_instance_manager = None


def get_single_instance() -> SingleInstanceManager:
    global _instance_manager
    if _instance_manager is None:
        _instance_manager = SingleInstanceManager()
    return _instance_manager
