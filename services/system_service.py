"""
시스템 정보, IP 조회 및 네트워크 진단 서비스 모듈
"""
import os
import platform
import subprocess
import socket
import datetime
import urllib.request
import eel


def _get_public_ip():
    """외부 공인 IP 조회 (타임아웃 2.5초, 복수 엔드포인트 폴백)"""
    endpoints = [
        "https://api.ipify.org",
        "https://icanhazip.com",
        "https://checkip.amazonaws.com"
    ]
    for url in endpoints:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'curl/7.68.0'})
            with urllib.request.urlopen(req, timeout=2.5) as response:
                ip = response.read().decode('utf-8').strip()
                if ip:
                    return ip
        except Exception:
            continue
    return "조회 실패 (인터넷 연결 확인 필요)"


@eel.expose
def get_system_info():
    """현재 시스템 사양 및 로컬/공인 IP 조회"""
    try:
        uname = platform.uname()
        local_ip = "127.0.0.1"
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
        except Exception:
            local_ip = socket.gethostbyname(socket.gethostname())

        public_ip = _get_public_ip()

        info = {
            "OS": f"{uname.system} {uname.release} (버전: {uname.version})",
            "아키텍처": uname.machine,
            "호스트 이름": uname.node,
            "프로세서": uname.processor or platform.processor(),
            "Python 버전": platform.python_version(),
            "Local IP (내부망)": local_ip,
            "Public IP (공인)": public_ip,
            "현재 작업 디렉토리": os.getcwd()
        }
        return {"status": "success", "data": info}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def get_current_timestamp():
    """현재 날짜 및 시간 반환"""
    now = datetime.datetime.now()
    return {
        "status": "success",
        "data": {
            "formatted": now.strftime("%Y-%m-%d %H:%M:%S"),
            "iso": now.isoformat(),
            "timestamp": int(now.timestamp())
        }
    }


@eel.expose
def check_network_ping(host="8.8.8.8"):
    """네트워크 Ping 테스트"""
    try:
        result = subprocess.run(
            ["ping", "-n", "2", host],
            capture_output=True,
            text=True,
            encoding="cp949",
            timeout=5
        )
        return {
            "status": "success" if result.returncode == 0 else "warning",
            "message": result.stdout
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
