"""
시스템 정보, 하드웨어 사양(CPU/RAM/GPU/Storage), IP 조회 및 네트워크 진단 서비스 모듈
"""
import os
import sys
import time
import threading
import platform
import subprocess
import socket
import datetime
import urllib.request
import json
import ctypes
from ctypes import wintypes
import eel
from core.paths import APP_DIR, APP_VERSION
import core.logger



def _get_public_ip():
    """외부 공인 IP 조회 (타임아웃 2.0초, 복수 엔드포인트 폴백)"""
    endpoints = [
        "https://api.ipify.org",
        "https://icanhazip.com",
        "https://checkip.amazonaws.com"
    ]
    for url in endpoints:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'curl/7.68.0'})
            with urllib.request.urlopen(req, timeout=2.0) as response:
                ip = response.read().decode('utf-8').strip()
                if ip:
                    return ip
        except Exception:
            continue
    return "조회 불가 (인터넷 연결 확인 필요)"


def _get_hardware_info():
    """Windows PowerShell Get-CimInstance를 활용한 정밀 하드웨어 사양 수집"""
    hw_info = {
        "CPU": None,
        "RAM": None,
        "GPU": None,
        "Storage": []
    }

    if platform.system() != "Windows":
        return hw_info

    try:
        ps_script = """
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed
        $os = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory
        $gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notlike "*Mirage*" -and $_.Name -notlike "*Virtual*" -and $_.Name -notlike "*Remote*" } | Select-Object Name, DriverVersion, AdapterRAM
        if (-not $gpu) {
            $gpu = Get-CimInstance Win32_VideoController | Select-Object -First 1 Name, DriverVersion, AdapterRAM
        }
        $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Where-Object { $_.Size -gt 0 } | Select-Object DeviceID, Size, FreeSpace

        [PSCustomObject]@{
            CPU = $cpu
            OS = $os
            GPU = $gpu
            Disks = $disks
        } | ConvertTo-Json -Depth 3 -Compress
        """
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=4.0
        )

        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout.strip())

            # 1. CPU 정보 가공
            if data.get("CPU"):
                cpu_raw = data["CPU"]
                cpu_name = (cpu_raw.get("Name") or "").strip()
                cores = cpu_raw.get("NumberOfCores")
                threads = cpu_raw.get("NumberOfLogicalProcessors")
                max_clock = cpu_raw.get("MaxClockSpeed")
                clock_str = f" @ {max_clock / 1000:.2f} GHz" if max_clock else ""
                hw_info["CPU"] = f"{cpu_name} ({cores} 코어 / {threads} 스레드{clock_str})"

            # 2. RAM 정보 가공
            if data.get("OS"):
                os_mem = data["OS"]
                total_kb = os_mem.get("TotalVisibleMemorySize") or 0
                free_kb = os_mem.get("FreePhysicalMemory") or 0
                if total_kb > 0:
                    total_gb = total_kb / (1024 * 1024)
                    free_gb = free_kb / (1024 * 1024)
                    used_gb = total_gb - free_gb
                    usage_pct = (used_gb / total_gb) * 100
                    hw_info["RAM"] = f"총 {total_gb:.2f} GB (사용 중: {used_gb:.2f} GB / {usage_pct:.1f}%, 여유: {free_gb:.2f} GB)"

            # 3. GPU 정보 가공
            if data.get("GPU"):
                gpu_list = data["GPU"] if isinstance(data["GPU"], list) else [data["GPU"]]
                gpu_strs = []
                for g in gpu_list:
                    g_name = (g.get("Name") or "").strip()
                    vram_bytes = g.get("AdapterRAM") or 0
                    driver_ver = g.get("DriverVersion") or ""
                    vram_str = f", VRAM: {vram_bytes / (1024**3):.2f} GB" if vram_bytes > 0 else ""
                    driver_str = f" [드라이버: {driver_ver}]" if driver_ver else ""
                    if g_name:
                        gpu_strs.append(f"{g_name}{vram_str}{driver_str}")
                if gpu_strs:
                    hw_info["GPU"] = " | ".join(gpu_strs)

            # 4. Storage 정보 가공
            if data.get("Disks"):
                disk_list = data["Disks"] if isinstance(data["Disks"], list) else [data["Disks"]]
                disk_strs = []
                for d in disk_list:
                    dev_id = d.get("DeviceID") or ""
                    size = d.get("Size") or 0
                    free = d.get("FreeSpace") or 0
                    if size > 0:
                        total_d_gb = size / (1024**3)
                        free_d_gb = free / (1024**3)
                        used_pct = ((size - free) / size) * 100
                        disk_strs.append(f"{dev_id} ({free_d_gb:.1f} GB 남음 / {total_d_gb:.1f} GB, {used_pct:.0f}% 사용)")
                if disk_strs:
                    hw_info["Storage"] = disk_strs

    except Exception:
        pass

    return hw_info


@eel.expose
def get_system_info():
    """현재 시스템 사양, 하드웨어(CPU/RAM/GPU/Storage) 및 로컬/공인 IP 조회"""
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
        hw = _get_hardware_info()

        info = {
            "애플리케이션 버전": f"v{APP_VERSION}",
            "OS / 운영체제": f"{uname.system} {uname.release} (빌드: {uname.version})",
            "호스트 이름": uname.node,
            "시스템 아키텍처": uname.machine,
            "CPU (프로세서)": hw.get("CPU") or uname.processor or platform.processor(),
            "RAM (물리 메모리)": hw.get("RAM") or "조회 불가",
            "GPU (그래픽 카드)": hw.get("GPU") or "조회 불가 (기본 그래픽)",
            "저장공간 (디스크)": " / ".join(hw.get("Storage", [])) if hw.get("Storage") else "조회 불가",
            "Local IP (내부망)": local_ip,
            "Public IP (공인)": public_ip,
            "Python 런타임": f"Python {platform.python_version()} ({platform.architecture()[0]})",
            "작업 디렉토리": os.getcwd()
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


# ---------------------------------------------------------
# Win32 시스템 성능 메트릭 (위젯 및 모니터링 공용)
# ---------------------------------------------------------
class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", wintypes.DWORD),
        ("dwMemoryLoad", wintypes.DWORD),
        ("ullTotalPhys", ctypes.c_uint64),
        ("ullAvailPhys", ctypes.c_uint64),
        ("ullTotalPageFile", ctypes.c_uint64),
        ("ullAvailPageFile", ctypes.c_uint64),
        ("ullTotalVirtual", ctypes.c_uint64),
        ("ullAvailVirtual", ctypes.c_uint64),
        ("sullAvailExtendedVirtual", ctypes.c_uint64),
    ]

_last_idle_time = 0
_last_kernel_time = 0
_last_user_time = 0

@eel.expose
def get_system_metrics():
    """실시간 CPU 및 RAM 사용률 조회 (ctypes 기반 초경량 논블로킹)"""
    global _last_idle_time, _last_kernel_time, _last_user_time
    mem_load = 0
    cpu_percent = 0.0

    try:
        # RAM 사용률
        stat = _MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            mem_load = int(stat.dwMemoryLoad)

        # CPU 사용률 (직전 호출과의 델타 계산)
        idle_ft = _FILETIME()
        kernel_ft = _FILETIME()
        user_ft = _FILETIME()
        if ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle_ft), ctypes.byref(kernel_ft), ctypes.byref(user_ft)):
            def _to_i(ft):
                return (ft.dwHighDateTime << 32) | ft.dwLowDateTime

            i = _to_i(idle_ft)
            k = _to_i(kernel_ft)
            u = _to_i(user_ft)

            if _last_idle_time != 0:
                d_idle = i - _last_idle_time
                d_total = (k - _last_kernel_time) + (u - _last_user_time)
                if d_total > 0:
                    cpu_percent = max(0.0, min(100.0, (1.0 - (d_idle / d_total)) * 100.0))
            _last_idle_time, _last_kernel_time, _last_user_time = i, k, u

        return {
            "status": "success",
            "data": {
                "cpu_percent": round(cpu_percent, 1),
                "memory_percent": mem_load,
                "power_status": "AC 전원 연결됨"
            }
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def open_main_window():
    """트레이 관리자를 통해 메인 애플리케이션 창 열기/활성화"""
    try:
        from core.tray import get_tray_instance
        tm = get_tray_instance()
        if tm:
            tm.open_or_show_window()
            return {"status": "success"}
        return {"status": "error", "message": "TrayManager 인스턴스를 찾을 수 없습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def shutdown_app():
    """
    백엔드 서버 및 시스템 트레이 프로세스 완전 종료
    비동기 스레드에서 브라우저 응답 전송 후 리소스 정리 및 단일 인스턴스 세마포어 해제
    """
    def _do_shutdown():
        time.sleep(0.3)
        core.logger.log_event("info", "system", "Web UI 요청에 의한 백엔드 서버 및 트레이 완전 종료")
        try:
            from core.tray import get_tray_instance
            tm = get_tray_instance()
            if tm:
                tm.request_shutdown()
        except Exception as e:
            core.logger.log_event("warn", "system", f"종료 정리 예외: {e}")

    threading.Thread(target=_do_shutdown, daemon=True).start()
    return {"status": "success", "message": "애플리케이션과 백엔드 서버를 완전히 종료합니다."}


@eel.expose
def restart_app():
    """
    백엔드 서버 및 애플리케이션 즉시 재시작 (파이썬 코드 변경 사항 실시간 반영)
    기존 인스턴스 리소스 정리 ➔ 신규 인스턴스 백그라운드 구동 ➔ 기존 프로세스 종료
    """
    def _do_restart():
        time.sleep(0.4)
        core.logger.log_event("info", "system", "Web UI 요청에 의한 백엔드 서버 재시작 시작")

        # 신규 프로세스 실행 커맨드 구성
        try:
            if getattr(sys, 'frozen', False):
                cmd = [sys.executable] + sys.argv[1:]
            else:
                entry_script = os.path.abspath(sys.argv[0]) if sys.argv and sys.argv[0] else os.path.join(APP_DIR, "main.py")
                cmd = [sys.executable, entry_script] + sys.argv[1:]

            subprocess.Popen(
                cmd,
                cwd=APP_DIR,
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            )
            core.logger.log_event("info", "system", "신규 백엔드 프로세스 구동 완료")
        except Exception as e:
            core.logger.log_event("error", "system", f"신규 프로세스 구동 실패: {e}")

        try:
            from core.tray import get_tray_instance
            tm = get_tray_instance()
            if tm:
                tm.request_shutdown()
        except Exception as e:
            core.logger.log_event("warn", "system", f"재시작 정리 예외: {e}")

    threading.Thread(target=_do_restart, daemon=True).start()
    return {"status": "success", "message": "백엔드 서버를 재시작하는 중입니다..."}


