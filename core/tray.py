"""
시스템 트레이(System Tray) & 윈도우 생명주기 관리 모듈
"""
import os
import threading
from PIL import Image, ImageDraw
import pystray
import eel
from core.paths import ICON_PATH, BUNDLE_DIR


_tray_instance = None


def show_tray_notification(title: str, message: str):
    """트레이 아이콘을 통한 Windows 시스템 OS 알림 전송"""
    global _tray_instance
    if _tray_instance and _tray_instance.tray_icon:
        try:
            _tray_instance.tray_icon.notify(message, title)
            return True
        except Exception as e:
            print(f"[TrayManager] 알림 전송 실패: {e}")
    return False


class TrayManager:
    def __init__(self, base_dir=None, start_options=None, on_exit=None):
        global _tray_instance
        _tray_instance = self
        self.base_dir = base_dir or BUNDLE_DIR
        self.start_options = start_options or {}
        self.on_exit = on_exit
        self.ico_file = ICON_PATH
        self.tray_icon = None

    def get_tray_image(self):
        """트레이 아이콘 이미지 로드 (utiltools.ico 우선 -> 실패 시 기본 이미지 생성)"""
        if os.path.exists(self.ico_file):
            try:
                return Image.open(self.ico_file)
            except Exception as e:
                print(f"utiltools.ico 로드 실패, 기본 이미지 사용: {e}")

        # Fallback 기본 이미지 생성 (64x64 보라색 둥근 사각형 + 렌치 심볼 느낌)
        width, height = 64, 64
        img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle([4, 4, width - 4, height - 4], radius=14, fill="#4f46e5", outline="#818cf8", width=2)
        draw.ellipse([18, 18, width - 18, height - 18], fill="#10b981")
        draw.ellipse([26, 26, width - 26, height - 26], fill="#ffffff")
        return img

    def open_or_show_window(self):
        """창 열기 또는 다시 띄우기"""
        try:
            eel.show('index.html')
        except Exception:
            pass

    def on_tray_show(self, icon, item):
        """트레이 메뉴: 창 열기"""
        self.open_or_show_window()

    def on_tray_quit(self, icon, item):
        """트레이 메뉴: 프로그램 완전 종료"""
        if self.tray_icon:
            try:
                self.tray_icon.stop()
            except Exception:
                pass
        if self.on_exit:
            self.on_exit()
        os._exit(0)

    def run_eel_server(self):
        """Eel 웹 서버 구동"""
        try:
            eel.start('index.html', **self.start_options)
        except EnvironmentError:
            try:
                self.start_options['mode'] = 'edge'
                eel.start('index.html', **self.start_options)
            except Exception:
                self.start_options['mode'] = 'default'
                eel.start('index.html', **self.start_options)
        except Exception as e:
            print(f"Eel 종료/오류: {e}")

    def start(self):
        """서버 스레드 및 트레이 아이콘 메시지 루프 시작"""
        # 1. Eel 서버를 백그라운드 스레드에서 시작
        eel_thread = threading.Thread(target=self.run_eel_server, daemon=True)
        eel_thread.start()

        # 2. 시스템 트레이 메뉴 구성
        menu = pystray.Menu(
            pystray.MenuItem("🛠️ 도구 모음 열기", self.on_tray_show, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("🚪 완전히 종료", self.on_tray_quit)
        )

        tray_image = self.get_tray_image()
        self.tray_icon = pystray.Icon(
            "UtilityToolkit",
            tray_image,
            "Utility Toolkit (유틸리티 도구 모음)",
            menu=menu
        )

        # 3. 메인 스레드에서 트레이 아이콘 메시지 루프 실행 (블로킹)
        try:
            self.tray_icon.run()
        except (KeyboardInterrupt, SystemExit):
            self.on_tray_quit(self.tray_icon, None)
