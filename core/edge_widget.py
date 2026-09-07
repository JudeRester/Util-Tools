"""
core/edge_widget.py
화면 가장자리 플로팅 Edge Handle 및 Expandable Quick Widget 관리 모듈.
- pywebview 6.2.x 단일 창 생명주기 관리 (20x120 핸들 ↔ 380x620 확장 위젯)
- FixPoint(N/S | E/W) 기반 화면 경계 초과 방지 양방향 리사이징
- window.events.moved 수신 및 150ms debounce settle 기반 nearest-edge 스냅
- FullscreenGuard 연동을 통한 전체화면 애플리케이션 실행 시 SW_SHOWNOACTIVATE 비탈취 복원
- data/widget_config.json 영속성 관리 (edge, offset_ratio, device_name)
"""
import json
import logging
import os
import threading
import time
from typing import Any, Dict, Optional, Tuple

import webview
from webview.window import FixPoint

from core.fullscreen_guard import FullscreenGuard, MonitorGeometry
from core.paths import DATA_DIR, WIDGET_CONFIG_PATH

logger = logging.getLogger("UtilTools.EdgeWidget")

HANDLE_PRESETS = {
    "slim": {"width": 12, "height": 70, "label": "슬림 (12×70)"},
    "default": {"width": 20, "height": 120, "label": "기본 (20×120)"},
    "compact": {"width": 8, "height": 50, "label": "컴팩트 (8×50)"}
}

DEFAULT_HANDLE_PRESET = "slim"
EXPANDED_WIDTH = 380
EXPANDED_HEIGHT = 620

SW_HIDE = 0
SW_SHOWNOACTIVATE = 4


class WidgetState:
    COLLAPSED = "COLLAPSED"
    EXPANDED = "EXPANDED"
    SUPPRESSED = "SUPPRESSED"


class EdgeWidgetConfig:
    """위젯 위치 및 설정 영속성 모델."""

    def __init__(
        self,
        edge: str = "right",
        offset_ratio: float = 0.15,
        device_name: Optional[str] = None,
        enabled: bool = True,
        handle_size: str = DEFAULT_HANDLE_PRESET
    ):
        self.edge = "left" if edge == "left" else "right"
        self.offset_ratio = max(0.0, min(1.0, float(offset_ratio)))
        self.device_name = device_name
        self.enabled = bool(enabled)
        self.handle_size = handle_size if handle_size in HANDLE_PRESETS else DEFAULT_HANDLE_PRESET

    def to_dict(self) -> Dict[str, Any]:
        return {
            "edge": self.edge,
            "offset_ratio": round(self.offset_ratio, 4),
            "device_name": self.device_name,
            "enabled": self.enabled,
            "handle_size": self.handle_size
        }

    @classmethod
    def load(cls) -> "EdgeWidgetConfig":
        os.makedirs(DATA_DIR, exist_ok=True)
        if not os.path.exists(WIDGET_CONFIG_PATH):
            config = cls()
            config.save()
            return config

        try:
            with open(WIDGET_CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            return cls(
                edge=data.get("edge", "right"),
                offset_ratio=data.get("offset_ratio", 0.15),
                device_name=data.get("device_name"),
                enabled=data.get("enabled", True),
                handle_size=data.get("handle_size", DEFAULT_HANDLE_PRESET)
            )
        except Exception as e:
            logger.warning("Failed to load widget config, resetting to default: %s", e)
            config = cls()
            config.save()
            return config

    def save(self) -> None:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            tmp_path = f"{WIDGET_CONFIG_PATH}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(self.to_dict(), f, indent=2, ensure_ascii=False)
            if os.path.exists(WIDGET_CONFIG_PATH):
                os.replace(tmp_path, WIDGET_CONFIG_PATH)
            else:
                os.rename(tmp_path, WIDGET_CONFIG_PATH)
        except Exception as e:
            logger.error("Failed to save widget config: %s", e)


class EdgeWidgetApi:
    """프론트엔드 window.pywebview.api를 통해 호출되는 브리지 엔드포인트."""

    def __init__(self, manager: "EdgeWidgetManager"):
        self._manager = manager

    def expand(self) -> Dict[str, Any]:
        return self._manager.expand()

    def collapse(self) -> Dict[str, Any]:
        return self._manager.collapse()

    def toggle(self) -> Dict[str, Any]:
        return self._manager.toggle()

    def get_state(self) -> Dict[str, Any]:
        return self._manager.get_state_dict()

    def close(self) -> None:
        self._manager.collapse()

    def set_handle_size(self, size_key: str) -> Dict[str, Any]:
        return self._manager.set_handle_size(size_key)

    def get_handle_size(self) -> str:
        return self._manager.config.handle_size

    def get_handle_presets(self) -> Dict[str, Any]:
        return HANDLE_PRESETS


_edge_widget_manager_instance: Optional["EdgeWidgetManager"] = None


def get_edge_widget_manager() -> Optional["EdgeWidgetManager"]:
    """EdgeWidgetManager 전역 싱글톤 인스턴스 반환."""
    global _edge_widget_manager_instance
    return _edge_widget_manager_instance


class EdgeWidgetManager:
    """단일 Edge Widget 창의 생명주기, 확장/축소 및 스냅 위치를 관리하는 컨트롤러."""

    def __init__(self):
        global _edge_widget_manager_instance
        _edge_widget_manager_instance = self
        self.config = EdgeWidgetConfig.load()
        self.state = WidgetState.COLLAPSED
        self.window: Optional[webview.Window] = None
        self.guard: Optional[FullscreenGuard] = None

        self.handle_anchor_y = 100
        self._hwnd: Optional[int] = None
        self._lock = threading.Lock()
        self._settle_timer: Optional[threading.Timer] = None
        self._initialized = False
        self._is_settling = False

    @property
    def handle_width(self) -> int:
        preset = HANDLE_PRESETS.get(self.config.handle_size, HANDLE_PRESETS[DEFAULT_HANDLE_PRESET])
        return preset["width"]

    @property
    def handle_height(self) -> int:
        preset = HANDLE_PRESETS.get(self.config.handle_size, HANDLE_PRESETS[DEFAULT_HANDLE_PRESET])
        return preset["height"]

    def create_window(self, eel_port: int) -> webview.Window:
        """pywebview 창 생성 (프레임리스, 상단 고정, 초기 화면 가장자리 안착)."""
        url = f"http://127.0.0.1:{eel_port}/widget.html"

        # 모니터 작업 영역 기반 초기 좌표 산출
        monitor = None
        if self.config.device_name:
            monitor = MonitorGeometry.from_device_name(self.config.device_name)
        if not monitor:
            all_m = MonitorGeometry.get_all_monitors()
            monitor = all_m[0] if all_m else None

        if monitor:
            init_y = monitor.logical_work_top + self.config.offset_ratio * max(
                1.0, (monitor.logical_work_height - self.handle_height)
            )
            init_y = max(monitor.logical_work_top, min(init_y, monitor.logical_work_bottom - self.handle_height))
            self.handle_anchor_y = init_y
            init_x = (monitor.logical_work_right - self.handle_width) if self.config.edge == "right" else monitor.logical_work_left
        else:
            init_x, init_y = 1800, 100

        self.window = webview.create_window(
            title="UtilTools_EdgeWidget",
            url=url,
            x=int(init_x),
            y=int(init_y),
            width=self.handle_width,
            height=self.handle_height,
            min_size=(6, 40),
            frameless=True,
            on_top=True,
            easy_drag=False,
            background_color="#1e1e2d",
            js_api=EdgeWidgetApi(self)
        )

        self.window.events.shown += self._on_window_shown
        self.window.events.moved += self._on_window_moved
        return self.window

    def start_guard(self) -> None:
        """FullscreenGuard 가동."""
        self.guard = FullscreenGuard(
            on_suppress_change=self._handle_fullscreen_change,
            target_device_name=self.config.device_name
        )
        self.guard.start()

    def _on_window_shown(self) -> None:
        """창 표시 직후 WinForms Form 초기화 및 위치/크기 확정."""
        try:
            # 1. HWND 획득
            if self.window and self.window.native and hasattr(self.window.native, "Handle"):
                h_val = self.window.native.Handle
                self._hwnd = int(h_val.ToInt64()) if hasattr(h_val, "ToInt64") else int(h_val)

            # 2. Form.None 후 최소 폭 강제 적용 (SM_CXMINTRACK 회피)
            if self.window:
                self.window.resize(self.handle_width, self.handle_height)
                self._notify_client_handle_size(self.config.handle_size)

            self._initialized = True
        except Exception as e:
            logger.error("Error during _on_window_shown initialization: %s", e)


    def _get_current_monitor(self) -> Optional[MonitorGeometry]:
        """현재 창의 logical 좌표가 위치한 MonitorGeometry 반환."""
        if not self.window:
            return None
        return MonitorGeometry.from_point(self.window.x, self.window.y)

    def _get_anchored_fixpoint(self, monitor: MonitorGeometry) -> FixPoint:
        """Y축 위치에 따른 수직 앵커(NORTH/SOUTH) 및 가장자리에 따른 수평 앵커(EAST/WEST) 산출."""
        # 수직 앵커: 창 확장 시 모니터 작업영역 하단을 벗어나면 SOUTH 고정 (위로 확장)
        if self.handle_anchor_y + EXPANDED_HEIGHT <= monitor.logical_work_bottom:
            v_fix = FixPoint.NORTH
        else:
            v_fix = FixPoint.SOUTH

        # 수평 앵커: 우측 엣지면 EAST 고정 (왼쪽으로 확장), 좌측 엣지면 WEST 고정 (오른쪽으로 확장)
        h_fix = FixPoint.EAST if self.config.edge == "right" else FixPoint.WEST
        return v_fix | h_fix

    def expand(self) -> Dict[str, Any]:
        """핸들을 Quick Widget으로 확장."""
        with self._lock:
            if self.state == WidgetState.SUPPRESSED:
                return {"success": False, "reason": "suppressed"}
            if self.state == WidgetState.EXPANDED:
                return {"success": True, "state": self.state}
            if not self.window:
                return {"success": False, "reason": "no_window"}

            monitor = self._get_current_monitor()
            if not monitor:
                all_m = MonitorGeometry.get_all_monitors()
                monitor = all_m[0] if all_m else None

            if monitor:
                anchor = self._get_anchored_fixpoint(monitor)
                self.window.resize(EXPANDED_WIDTH, EXPANDED_HEIGHT, fix_point=anchor)

            self.state = WidgetState.EXPANDED

        logger.info("Widget state transitioned to EXPANDED")
        self._notify_client_state(WidgetState.EXPANDED)
        return {"success": True, "state": self.state}

    def collapse(self) -> Dict[str, Any]:
        """확장된 위젯을 원래 핸들 크기로 축소 복원."""
        with self._lock:
            if self.state == WidgetState.COLLAPSED:
                return {"success": True, "state": self.state}
            if not self.window:
                return {"success": False, "reason": "no_window"}

            monitor = self._get_current_monitor()
            if not monitor:
                all_m = MonitorGeometry.get_all_monitors()
                monitor = all_m[0] if all_m else None

            if monitor:
                anchor = self._get_anchored_fixpoint(monitor)
                self.window.resize(self.handle_width, self.handle_height, fix_point=anchor)

            self.state = WidgetState.COLLAPSED

        logger.info("Widget state transitioned to COLLAPSED")
        self._notify_client_state(WidgetState.COLLAPSED)
        return {"success": True, "state": self.state}

    def set_handle_size(self, size_key: str) -> Dict[str, Any]:
        """핸들 크기 프리셋 변경 및 즉시/지연 반영."""
        if size_key not in HANDLE_PRESETS:
            return {"success": False, "error": f"Unknown preset: {size_key}"}

        with self._lock:
            self.config.handle_size = size_key
            self.config.save()

            # 클라이언트(JS)에 크기 변경 통지
            self._notify_client_handle_size(size_key)

            # 접힌 상태이면 즉시 창 크기 리사이징 및 엣지 스냅
            if self.state == WidgetState.COLLAPSED and self.window:
                monitor = self._get_current_monitor()
                if not monitor:
                    all_m = MonitorGeometry.get_all_monitors()
                    monitor = all_m[0] if all_m else None

                if monitor:
                    anchor = self._get_anchored_fixpoint(monitor)
                    self.window.resize(self.handle_width, self.handle_height, fix_point=anchor)
                    snap_x = (monitor.logical_work_right - self.handle_width) if self.config.edge == "right" else monitor.logical_work_left
                    clamped_y = max(monitor.logical_work_top, min(self.handle_anchor_y, monitor.logical_work_bottom - self.handle_height))
                    self._is_settling = True
                    self.window.move(int(snap_x), int(clamped_y))

        logger.info("Widget handle size updated to: %s (%dx%d)", size_key, self.handle_width, self.handle_height)
        return {"success": True, "size": size_key, "width": self.handle_width, "height": self.handle_height}

    def _notify_client_handle_size(self, size_key: str) -> None:
        """프론트엔드 JavaScript에 핸들 크기 프리셋 변경 알림."""
        if not self.window:
            return
        try:
            self.window.evaluate_js(f"window.onHandleSizeChanged && window.onHandleSizeChanged('{size_key}')")
        except Exception:
            pass

    def toggle(self) -> Dict[str, Any]:
        if self.state == WidgetState.EXPANDED:
            return self.collapse()
        elif self.state == WidgetState.COLLAPSED:
            return self.expand()
        return {"success": False, "state": self.state}

    def _notify_client_state(self, new_state: str) -> None:
        """프론트엔드 JavaScript에 상태 변경 알림."""
        if not self.window:
            return
        try:
            self.window.evaluate_js(f"window.onWidgetStateChanged && window.onWidgetStateChanged('{new_state}')")
        except Exception:
            pass

    def _notify_client_edge(self, new_edge: str) -> None:
        """프론트엔드 JavaScript에 엣지 방향(left/right) 변경 알림."""
        if not self.window:
            return
        try:
            self.window.evaluate_js(f"window.onEdgeChanged && window.onEdgeChanged('{new_edge}')")
        except Exception:
            pass

    def _on_window_moved(self, x: int, y: int) -> None:
        """드래그 이동 감지 시 150ms debounce settle 타이머 작동."""
        if not self._initialized or self.state == WidgetState.EXPANDED:
            return

        if self._is_settling:
            self._is_settling = False
            return

        with self._lock:
            if self._settle_timer:
                self._settle_timer.cancel()
            self._settle_timer = threading.Timer(0.15, self._settle_position, args=(x, y))
            self._settle_timer.daemon = True
            self._settle_timer.start()

    def _settle_position(self, cur_x: int, cur_y: int) -> None:
        """드래그 정지 후 가장 가까운 모니터 엣지로 스냅 및 설정 저장."""
        with self._lock:
            if self.state == WidgetState.EXPANDED or not self.window:
                return

            monitor = MonitorGeometry.from_point(cur_x, cur_y)
            if not monitor:
                all_m = MonitorGeometry.get_all_monitors()
                monitor = all_m[0] if all_m else None

            if not monitor:
                return

            # 좌우 중 가장 가까운 엣지 판정
            dist_left = abs(cur_x - monitor.logical_work_left)
            dist_right = abs((monitor.logical_work_right - self.handle_width) - cur_x)
            new_edge = "right" if dist_right <= dist_left else "left"

            snap_x = (monitor.logical_work_right - self.handle_width) if new_edge == "right" else monitor.logical_work_left

            # Y축 작업 영역 내 클램핑
            clamped_y = max(monitor.logical_work_top, min(cur_y, monitor.logical_work_bottom - self.handle_height))
            self.handle_anchor_y = clamped_y

            # 이미 스냅 위치와 거의 일치하면(3px 이내) 재이동 및 파일 저장 스킵
            if abs(cur_x - snap_x) <= 3 and abs(cur_y - clamped_y) <= 3:
                return

            denom = max(1.0, (monitor.logical_work_height - self.handle_height))
            offset_ratio = (clamped_y - monitor.logical_work_top) / denom

            edge_changed = (new_edge != self.config.edge)
            self.config.edge = new_edge
            self.config.offset_ratio = offset_ratio
            self.config.device_name = monitor.device_name
            self.config.save()

            # 창 실제 이동 (이동 이벤트 재귀 방지 플래그 설정)
            self._is_settling = True
            self.window.move(int(snap_x), int(clamped_y))

            # FullscreenGuard 타겟 디바이스 갱신
            if self.guard:
                self.guard.set_target_device_name(monitor.device_name)


        if edge_changed:
            self._notify_client_edge(new_edge)
        logger.info("Widget settled to %s edge at (%d, %d) on %s", new_edge, int(snap_x), int(clamped_y), monitor.device_name)

    def _handle_fullscreen_change(self, suppressed: bool) -> None:
        """전체화면 전환 이벤트 처리 (SW_HIDE ↔ SW_SHOWNOACTIVATE)."""
        import ctypes
        user32 = ctypes.windll.user32

        with self._lock:
            if suppressed:
                if self.state == WidgetState.EXPANDED:
                    # 확장된 상태면 축소
                    monitor = self._get_current_monitor()
                    if monitor and self.window:
                        anchor = self._get_anchored_fixpoint(monitor)
                        self.window.resize(self.handle_width, self.handle_height, fix_point=anchor)
                self.state = WidgetState.SUPPRESSED
                if self._hwnd:
                    user32.ShowWindow(self._hwnd, SW_HIDE)
                logger.info("Widget suppressed due to fullscreen application")
            else:
                if self.state == WidgetState.SUPPRESSED:
                    self.state = WidgetState.COLLAPSED
                    if self._hwnd:
                        user32.ShowWindow(self._hwnd, SW_SHOWNOACTIVATE)
                    logger.info("Widget restored with SW_SHOWNOACTIVATE")

    def get_state_dict(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "state": self.state,
                "edge": self.config.edge,
                "offset_ratio": self.config.offset_ratio,
                "device_name": self.config.device_name,
                "enabled": self.config.enabled,
                "anchor_y": self.handle_anchor_y
            }

    def destroy(self) -> None:
        """리소스 해제 및 감시자 중지."""
        if self._settle_timer:
            self._settle_timer.cancel()
        if self.guard:
            self.guard.stop()
        if self.window:
            try:
                self.window.destroy()
            except Exception:
                pass
        logger.info("EdgeWidgetManager destroyed")
