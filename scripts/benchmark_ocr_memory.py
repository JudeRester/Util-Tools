"""
scripts/benchmark_ocr_memory.py
OCR 엔진별 독립 격리 서브프로세스 메모리(Delta Peak RSS) 실측 스크립트

측정 방식:
각 엔진(Windows.Media.Ocr, RapidOCR v4, RapidOCR v5)을 독립된 fresh subprocess로 실행하여
1) 기본 프로세스 메모리(Baseline RSS)
2) 모델 로딩 및 1511x796 자막 이미지 추론 후 최대 메모리(Peak RSS)
3) 증분 메모리: Delta Peak RSS = Peak RSS - Baseline RSS
를 Windows API(GetProcessMemoryInfo)로 바이트 단위 정밀 계측하여 재현성을 보장합니다.
"""

import sys
import subprocess
from typing import Dict, Tuple

# 서브프로세스 내부에서 실행될 단일 엔진 프로파일러 코드
SUBPROCESS_PROFILER_CODE = '''
import sys
import time
import ctypes
from ctypes import wintypes
from PIL import Image

kernel32 = ctypes.windll.kernel32
psapi = ctypes.windll.psapi
kernel32.GetCurrentProcess.restype = ctypes.c_void_p

class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]

psapi.GetProcessMemoryInfo.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
    wintypes.DWORD
]

def get_memory_mb():
    handle = kernel32.GetCurrentProcess()
    c = PROCESS_MEMORY_COUNTERS_EX()
    c.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS_EX)
    psapi.GetProcessMemoryInfo(handle, ctypes.byref(c), c.cb)
    return c.WorkingSetSize / (1024.0 * 1024.0), c.PeakWorkingSetSize / (1024.0 * 1024.0)

engine = sys.argv[1]
base_ws, base_peak = get_memory_mb()

# 1511x796 이미지 생성 (테스트 페이로드)
img = Image.new("RGB", (1511, 796), color=(25, 20, 30))

if engine == "win":
    import winocr
    _ = winocr.recognize_pil_sync(img, "ko")
elif engine == "rapid_v4":
    import numpy as np
    from rapidocr import RapidOCR, EngineType, LangRec, ModelType, OCRVersion
    ocr = RapidOCR(params={
        "Det.engine_type": EngineType.ONNXRUNTIME,
        "Det.ocr_version": OCRVersion.PPOCRV4,
        "Det.model_type": ModelType.MOBILE,
        "Rec.engine_type": EngineType.ONNXRUNTIME,
        "Rec.lang_type": LangRec.KOREAN,
        "Rec.ocr_version": OCRVersion.PPOCRV4,
        "Rec.model_type": ModelType.MOBILE,
    })
    _ = ocr(np.array(img))
elif engine == "rapid_v5":
    import numpy as np
    from rapidocr import RapidOCR, EngineType, LangRec, ModelType, OCRVersion
    ocr = RapidOCR(params={
        "Det.engine_type": EngineType.ONNXRUNTIME,
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Det.model_type": ModelType.MOBILE,
        "Rec.engine_type": EngineType.ONNXRUNTIME,
        "Rec.lang_type": LangRec.KOREAN,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.MOBILE,
    })
    _ = ocr(np.array(img))
else:
    raise ValueError(f"Unknown engine: {engine}")

final_ws, final_peak = get_memory_mb()
delta_peak = final_peak - base_peak
print(f"{base_ws:.2f},{final_peak:.2f},{delta_peak:.2f}")
'''


def measure_isolated_memory() -> Dict[str, Tuple[float, float, float]]:
    """
    각 엔진을 별도의 파이썬 서브프로세스로 격리 실행하여
    {engine: (base_mb, peak_mb, delta_peak_mb)} 딕셔너리 반환
    """
    results = {}
    engines = [("win", "Windows.Media.Ocr")]

    try:
        import rapidocr  # noqa: F401
        has_rapid = True
    except ImportError:
        has_rapid = False

    if has_rapid:
        engines.extend([
            ("rapid_v4", "RapidOCR PP-OCRv4"),
            ("rapid_v5", "RapidOCR PP-OCRv5"),
        ])

    for eng_code, eng_label in engines:
        proc = subprocess.run(
            [sys.executable, "-c", SUBPROCESS_PROFILER_CODE, eng_code],
            capture_output=True,
            text=True,
            check=False
        )
        if proc.returncode == 0 and proc.stdout.strip():
            parts = proc.stdout.strip().split(",")
            base_mb = float(parts[0])
            peak_mb = float(parts[1])
            delta_mb = float(parts[2])
            results[eng_code] = (base_mb, peak_mb, delta_mb)
        else:
            err = proc.stderr.strip() or "Unknown subprocess error"
            print(f"[WARN] {eng_label} 메모리 계측 실패: {err}")
            results[eng_code] = (0.0, 0.0, 0.0)

    return results


def main():
    print("=" * 80)
    print("  OCR 엔진별 독립 격리 서브프로세스 메모리(Delta Peak RSS) 실측")
    print("  * 조건: Fresh Subprocess, 1511x796 이미지 단일 추론 기준")
    print("=" * 80)
    print(f"{'엔진명':25s} | {'Baseline RSS':14s} | {'Final Peak RSS':16s} | {'Delta Peak RSS':16s}")
    print("-" * 80)

    results = measure_isolated_memory()
    labels = {
        "win": "Windows.Media.Ocr",
        "rapid_v4": "RapidOCR PP-OCRv4",
        "rapid_v5": "RapidOCR PP-OCRv5"
    }

    for code, label in labels.items():
        if code in results:
            base_mb, peak_mb, delta_mb = results[code]
            print(f"{label:25s} | {base_mb:11.1f} MB | {peak_mb:13.1f} MB | +{delta_mb:12.1f} MB")

    print("=" * 80)


if __name__ == "__main__":
    main()
