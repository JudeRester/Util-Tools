"""
core/fullscreen_guard.py
전체화면 애플리케이션(게임, 비디오 플레이어, 프레젠테이션 등) 감지 및 위젯 억제/복원 모듈.
- Win32 SetWinEventHook 전용 메시지 루프 스레드 기반 실시간 포그라운드 이벤트 감지
- 500ms Fallback 폴링 타이머로 비동기 상태 누락 방지
- _fullscreen_hwnd 추적: 포그라운드가 다른 모니터로 변경되어도 기존 모니터 전체화면 상태 유지
- MonitorGeometry: Win32 physical 좌표와 pywebview logical 좌표계 분리 및 정규화
"""
import ctypes
import logging
import threading
import time
from ctypes import wintypes
from typing import Callable, Dict, List, Optional, Tuple

import webview

logger = logging.getLogger("UtilTools.FullscreenGuard")

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
kernel32 = ctypes.windll.kernel32

WINEVENT_OUTOFCONTEXT = 0x0000
EVENT_SYSTEM_FOREGROUND = 0x0003
WM_QUIT = 0x0012
DWMWA_EXTENDED_FRAME_BOUNDS = 9
MONITOR_DEFAULTTONEAREST = 2
SW_SHOWNOACTIVATE = 4

# Win32 콜백 프로토타입
WINEVENTPROC = ctypes.WINFUNCTYPE(
    None,
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.HWND,
    wintypes.LONG,
    wintypes.LONG,
    wintypes.DWORD,
    wintypes.DWORD
)


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
        ("szDevice", wintypes.WCHAR * 32)
    ]


class MonitorGeometry:
    """Win32 physical 좌표와 pywebview logical 좌표계 간의 변환 및 영역 정보를 관리하는 모델."""

    def __init__(
        self,
        device_name: str,
        hmon: int,
        rc_monitor: Tuple[int, int, int, int],
        rc_work: Tuple[int, int, int, int],
        screen: Optional[webview.Screen] = None
    ):
        self.device_name = device_name
        self.hmon = hmon
        self.rc_monitor = rc_monitor  # (left, top, right, bottom) in physical
        self.rc_work = rc_work        # (left, top, right, bottom) in physical
        self.screen = screen

        # DPI Scale 산출
        if screen and hasattr(screen, "scale") and screen.scale:
            self.scale = float(screen.scale)
        else:
            phys_w = rc_monitor[2] - rc_monitor[0]
            log_w = screen.width if screen and screen.width else phys_w
            self.scale = max(1.0, float(phys_w) / float(log_w)) if log_w else 1.0

        # Screen logical offsets
        self.screen_x = screen.x if screen else rc_monitor[0]
        self.screen_y = screen.y if screen else rc_monitor[1]

        # pywebview logical work area bounds
        phys_x = rc_monitor[0]
        phys_y = rc_monitor[1]
        self.logical_work_left = self.screen_x + (rc_work[0] - phys_x) / self.scale
        self.logical_work_top = self.screen_y + (rc_work[1] - phys_y) / self.scale
        self.logical_work_width = (rc_work[2] - rc_work[0]) / self.scale
        self.logical_work_height = (rc_work[3] - rc_work[1]) / self.scale
        self.logical_work_right = self.logical_work_left + self.logical_work_width
        self.logical_work_bottom = self.logical_work_top + self.logical_work_height

    def contains_logical_point(self, x: float, y: float) -> bool:
        """주어진 pywebview logical 좌표가 이 모니터의 화면 범위 내에 속하는지 검사."""
        if self.screen:
            return (
                self.screen.x <= x < self.screen.x + self.screen.width and
                self.screen.y <= y < self.screen.y + self.screen.height
            )
        return (
            self.logical_work_left <= x <= self.logical_work_right and
            self.logical_work_top <= y <= self.logical_work_bottom
        )

    @classmethod
    def get_all_monitors(cls) -> List["MonitorGeometry"]:
        """시스템의 모든 모니터를 열거하고 pywebview screens와 매핑하여 반환."""
        monitors_raw = []

        def _enum_proc(hmon, hdc, lprect, lparam):
            mi = MONITORINFOEXW()
            mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
            if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                monitors_raw.append({
                    "hmon": int(hmon),
                    "device": str(mi.szDevice),
                    "rc_monitor": (mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right, mi.rcMonitor.bottom),
                    "rc_work": (mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom)
                })
            return True

        enum_proc = ctypes.WINFUNCTYPE(
            wintypes.BOOL,
            wintypes.HMONITOR,
            wintypes.HDC,
            ctypes.POINTER(wintypes.RECT),
            wintypes.LPARAM
        )(_enum_proc)

        user32.EnumDisplayMonitors(0, 0, enum_proc, 0)

        try:
            pw_screens = list(webview.screens) if webview.screens else []
        except Exception:
            pw_screens = []

        result = []
        for m in monitors_raw:
            matched_screen = None
            for s in pw_screens:
                if s.x == m["rc_monitor"][0] and s.y == m["rc_monitor"][1]:
                    matched_screen = s
                    break

            geom = cls(
                device_name=m["device"],
                hmon=m["hmon"],
                rc_monitor=m["rc_monitor"],
                rc_work=m["rc_work"],
                screen=matched_screen
            )
            result.append(geom)

        return result

    @classmethod
    def from_device_name(cls, device_name: str) -> Optional["MonitorGeometry"]:
        """장치 식별자(Device Name)로 MonitorGeometry 검색."""
        all_mons = cls.get_all_monitors()
        for m in all_mons:
            if m.device_name == device_name:
                return m
        return all_mons[0] if all_mons else None

    @classmethod
    def from_point(cls, x: float, y: float) -> "MonitorGeometry":
        """logical 좌표가 속한 MonitorGeometry 검색."""
        all_mons = cls.get_all_monitors()
        for m in all_mons:
            if m.contains_logical_point(x, y):
                return m
        return all_mons[0] if all_mons else None


class FullscreenGuard:
    """전체화면 애플리케이션 감지 및 위젯 억제 상태를 관리하는 경량 감시자."""

    IGNORED_CLASSES = {
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "Windows.UI.Core.CoreWindow"
    }

    def __init__(
        self,
        on_suppress_change: Optional[Callable[[bool], None]] = None,
        target_device_name: Optional[str] = None
    ):
        self.on_suppress_change = on_suppress_change
        self.target_device_name = target_device_name
        self._is_suppressed = False

        self._fullscreen_hwnd: Optional[int] = None
        self._fullscreen_hmon: Optional[int] = None

        self._hook_thread: Optional[threading.Thread] = None
        self._hook_thread_id: Optional[int] = None
        self._hook_handle: Optional[int] = None
        self._hook_cfunc = None
        self._ready_event = threading.Event()

        self._poll_thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()

    @property
    def is_suppressed(self) -> bool:
        with self._lock:
            return self._is_suppressed

    def set_target_device_name(self, device_name: str) -> None:
        """위젯이 위치한 타겟 모니터 장치명을 갱신하고 상태를 즉시 재평가."""
        with self._lock:
            self.target_device_name = device_name
        self._evaluate_state()

    def _get_window_rect(self, hwnd: int) -> wintypes.RECT:
        """창의 물리적 외곽 바운딩 렉트 획득 (DWM 프레임 우선)."""
        rect = wintypes.RECT()
        hr = dwmapi.DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            ctypes.byref(rect),
            ctypes.sizeof(rect)
        )
        if hr != 0:
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return rect

    def _get_window_class_name(self, hwnd: int) -> str:
        """창의 윈도우 클래스명 획득."""
        buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buf, 256)
        return buf.value

    def _is_window_fullscreen(self, hwnd: int) -> Tuple[bool, Optional[int]]:
        """해당 창이 현재 위치한 모니터에서 전체화면 상태인지 검사."""
        if not hwnd or not user32.IsWindow(hwnd) or not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
            return False, None

        cls_name = self._get_window_class_name(hwnd)
        if cls_name in self.IGNORED_CLASSES:
            return False, None

        hmon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        if not hmon:
            return False, None

        mi = MONITORINFOEXW()
        mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
        if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            return False, None

        if self.target_device_name and str(mi.szDevice) != self.target_device_name:
            return False, int(hmon)

        w_rect = self._get_window_rect(hwnd)
        m_rect = mi.rcMonitor

        is_fs = (
            w_rect.left <= m_rect.left and
            w_rect.top <= m_rect.top and
            w_rect.right >= m_rect.right and
            w_rect.bottom >= m_rect.bottom
        )
        return is_fs, int(hmon)

    def _evaluate_state(self) -> None:
        """전체화면 상태를 재평가하고 필요 시 콜백 발송."""
        with self._lock:
            should_suppress = False

            if self._fullscreen_hwnd:
                is_fs, hmon = self._is_window_fullscreen(self._fullscreen_hwnd)
                if is_fs:
                    should_suppress = True
                else:
                    self._fullscreen_hwnd = None
                    self._fullscreen_hmon = None

            if not should_suppress:
                fg_hwnd = user32.GetForegroundWindow()
                if fg_hwnd:
                    is_fs, hmon = self._is_window_fullscreen(fg_hwnd)
                    if is_fs:
                        should_suppress = True
                        self._fullscreen_hwnd = fg_hwnd
                        self._fullscreen_hmon = hmon

            state_changed = (should_suppress != self._is_suppressed)
            self._is_suppressed = should_suppress

        if state_changed:
            logger.info("Fullscreen suppression state changed: %s (HWND: %s)", should_suppress, self._fullscreen_hwnd)
            if self.on_suppress_change:
                try:
                    self.on_suppress_change(should_suppress)
                except Exception as e:
                    logger.error("Error in on_suppress_change callback: %s", e)

    def _win_event_proc(self, hWinEventHook, event, hwnd, idObject, idChild, dwEventThread, dwmsEventTime):
        """WinEvent 콜백 (OBJID_WINDOW 이벤트만 처리)."""
        if idObject == 0:
            self._evaluate_state()

    def _hook_thread_main(self):
        """전용 Win32 메시지 루프 스레드 진입점."""
        self._hook_thread_id = kernel32.GetCurrentThreadId()
        self._hook_cfunc = WINEVENTPROC(self._win_event_proc)

        self._hook_handle = user32.SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            0,
            self._hook_cfunc,
            0,
            0,
            WINEVENT_OUTOFCONTEXT
        )

        if not self._hook_handle:
            logger.error("Failed to register SetWinEventHook for EVENT_SYSTEM_FOREGROUND")
            self._ready_event.set()
            return

        self._ready_event.set()

        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), 0, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

        if self._hook_handle:
            user32.UnhookWinEvent(self._hook_handle)
            self._hook_handle = None

    def _poll_thread_main(self):
        """500ms Fallback 주기 검사 스레드."""
        while self._running:
            try:
                self._evaluate_state()
            except Exception as e:
                logger.error("Error during fullscreen poll check: %s", e)
            time.sleep(0.5)

    def start(self) -> None:
        """감시자 스레드 시작."""
        if self._running:
            return

        self._running = True
        self._ready_event.clear()

        self._hook_thread = threading.Thread(
            target=self._hook_thread_main,
            name="FullscreenGuard-WinEvent",
            daemon=True
        )
        self._hook_thread.start()
        self._ready_event.wait(2.0)

        self._poll_thread = threading.Thread(
            target=self._poll_thread_main,
            name="FullscreenGuard-Poll",
            daemon=True
        )
        self._poll_thread.start()

        self._evaluate_state()
        logger.info("FullscreenGuard successfully started.")

    def stop(self) -> None:
        """감시자 스레드 안전 종료 및 리소스 해제."""
        if not self._running:
            return

        self._running = False

        if self._hook_thread_id:
            user32.PostThreadMessageW(self._hook_thread_id, WM_QUIT, 0, 0)

        if self._hook_thread and self._hook_thread.is_alive():
            self._hook_thread.join(timeout=2.0)

        if self._poll_thread and self._poll_thread.is_alive():
            self._poll_thread.join(timeout=2.0)

        self._hook_cfunc = None
        logger.info("FullscreenGuard stopped.")
