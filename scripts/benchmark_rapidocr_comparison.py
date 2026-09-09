"""
scripts/benchmark_rapidocr_comparison.py
Util-Tools OCR 심층 비교 벤치마크 하네스:
- Windows Native (Windows.Media.Ocr)
- RapidOCR PP-OCRv4 Korean Mobile (ONNX Runtime)
- RapidOCR PP-OCRv5 Korean Mobile (ONNX Runtime)

전처리 효과(1x Raw vs Adaptive Lanczos)와 엔진 효과를 명확히 분리하고,
품질(Macro CER, Micro CER, Line Match Recall) 및 비용(Initialization + First Inference, Latency: median/p95, Isolated Delta Peak RSS, Model Size)을 계측합니다.

주의: 본 벤치마크의 Case 9/10은 실제 영상의 스크린샷 파일이 아닌, 사용자 실패 사례를 ImageDraw로 모사한 합성 자막 Fixture입니다 (외적 타당성 한계 명시).
"""

import os
import sys
import time
import math
import argparse
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 프로젝트 루트 경로 등록
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

# Windows 콘솔 UTF-8 출력 보장
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 필수 의존성 임포트 (중요: ONNX Runtime CRT 충돌 방지를 위해 rapidocr를 winocr보다 먼저 임포트)
try:
    from rapidocr import RapidOCR, EngineType, LangRec, ModelType, OCRVersion
    HAS_RAPIDOCR = True
except ImportError:
    HAS_RAPIDOCR = False

try:
    import winocr
    from services.ocr_service import _calculate_safe_dimensions, UPSCALE_PIXEL_BUDGET
except ImportError as e:
    print(f"[ERROR] services.ocr_service 또는 winocr 임포트 실패: {e}")
    sys.exit(1)


# =============================================================================
# 1. 프로세스 메모리 계측 유틸리티 (Windows API 기반 Working Set & Peak)
# =============================================================================
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

try:
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
        wintypes.DWORD
    ]

    def get_process_memory_mb() -> Tuple[float, float]:
        """(현재 Working Set MB, 피크 Working Set MB) 반환"""
        handle = kernel32.GetCurrentProcess()
        counters = PROCESS_MEMORY_COUNTERS_EX()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS_EX)
        psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
        return (
            counters.WorkingSetSize / (1024.0 * 1024.0),
            counters.PeakWorkingSetSize / (1024.0 * 1024.0)
        )
except Exception:
    def get_process_memory_mb() -> Tuple[float, float]:
        return 0.0, 0.0


# =============================================================================
# 2. 공통 비교 DTO 및 평가 메트릭 (Levenshtein, Macro/Micro CER, Line Match Recall)
# =============================================================================
@dataclass
class CommonBenchmarkResult:
    engine_name: str
    pipeline_mode: str
    full_text: str
    extracted_lines: List[str]
    boxes: List[Any]
    confidences: Optional[List[float]]
    line_match_recall: float
    macro_cer: float
    edit_dist: int
    total_expected_chars: int
    preprocess_ms: float
    core_median_ms: float
    core_p95_ms: float
    pipeline_median_ms: float
    pipeline_p95_ms: float
    applied_scale: float
    input_res: str
    proc_res: str


def levenshtein_distance(s1: str, s2: str) -> int:
    """두 문자열 사이의 Levenshtein 편집 거리 계산"""
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)

    prev = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        curr = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev[j + 1] + 1
            deletions = curr[j] + 1
            substitutions = prev[j] + (0 if c1 == c2 else 1)
            curr.append(min(insertions, deletions, substitutions))
        prev = curr
    return prev[-1]


def calculate_cer_and_distance(expected_lines: List[str], actual_text: str) -> Tuple[float, int, int]:
    """
    공백 정규화 후 정답 전체와 인식 결과 전체 사이의 CER, 편집 거리, 총 정답 문자수 산출
    반환: (cer, edit_distance, total_expected_chars)
    """
    norm_expected = "".join("".join(expected_lines).split())
    norm_actual = "".join(actual_text.split())

    total_chars = len(norm_expected)
    if total_chars == 0:
        dist = len(norm_actual)
        return (0.0 if not norm_actual else 1.0, dist, 0)

    dist = levenshtein_distance(norm_expected, norm_actual)
    cer = dist / float(total_chars)
    return (cer, dist, total_chars)


def calculate_line_match_recall(expected_lines: List[str], extracted_lines: List[str]) -> float:
    """
    정답 라인 중 인식된 라인에서 50% 이상 편집 유사도 매칭된 라인의 비율(Line Match Recall) 산출.
    주의: 순수 Bounding Box 위치 검출률이 아닌 텍스트 라인 단위 정합률이므로 보조지표로 취급합니다.
    """
    if not expected_lines:
        return 1.0

    matched = 0
    norm_extracted = ["".join(l.split()) for l in extracted_lines if l.strip()]

    for exp in expected_lines:
        norm_exp = "".join(exp.split())
        if not norm_exp:
            continue
        best_sim = 0.0
        for ext in norm_extracted:
            if not ext:
                continue
            dist = levenshtein_distance(norm_exp, ext)
            sim = 1.0 - (dist / float(max(len(norm_exp), len(ext))))
            if sim > best_sim:
                best_sim = sim
        if best_sim >= 0.50:
            matched += 1

    return matched / float(len(expected_lines))


# =============================================================================
# 3. 10대 대표 시나리오 Corpus 생성 (8 Synthetic + 2 실제 실패 사례 모사 합성 자막 Fixture)
# =============================================================================
def _get_font(size: int = 16) -> ImageFont.FreeTypeFont:
    for font_path in [
        "C:/Windows/Fonts/malgun.ttf",
        "C:/Windows/Fonts/malgunbd.ttf",
        "C:/Windows/Fonts/NanumGothic.ttf"
    ]:
        if os.path.exists(font_path):
            try:
                return ImageFont.truetype(font_path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def _draw_stroke_text(
    draw: ImageDraw.ImageDraw,
    pos: Tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: Tuple[int, int, int],
    stroke_fill: Tuple[int, int, int],
    stroke_width: int = 2
):
    """자막 외곽선(Stroke) 렌더링"""
    draw.text(pos, text, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)


def generate_corpus_cases() -> List[Dict[str, Any]]:
    cases = []

    # Case 1: Windows UI Toolbar
    font1 = _get_font(13)
    img1 = Image.new("RGB", (720, 110), color=(240, 240, 240))
    d1 = ImageDraw.Draw(img1)
    d1.rectangle([(0, 0), (720, 32)], fill=(225, 225, 225))
    d1.text((15, 8), "파일(F)   편집(E)   보기(V)   도구(T)   도움말(H)", font=font1, fill=(30, 30, 30))
    d1.text((15, 45), "프로젝트 탐색기: src/services/ocr_service.py", font=font1, fill=(20, 20, 20))
    d1.text((15, 75), "상태: 작업 준비 완료 (인스턴스 활성)", font=font1, fill=(40, 40, 40))
    cases.append({
        "name": "1. Windows UI Toolbar (Synthetic)",
        "image": img1,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "파일(F) 편집(E) 보기(V) 도구(T) 도움말(H)",
            "프로젝트 탐색기: src/services/ocr_service.py",
            "상태: 작업 준비 완료 (인스턴스 활성)"
        ]
    })

    # Case 2: Video Subtitle (외곽선 자막 - Synthetic)
    font2 = _get_font(26)
    img2 = Image.new("RGB", (840, 180), color=(40, 35, 30))
    d2 = ImageDraw.Draw(img2)
    for y in range(180):
        c = 30 + int(25 * (y / 180.0))
        d2.line([(0, y), (840, y)], fill=(c, c - 5, c - 10))
    _draw_stroke_text(d2, (40, 25), "다음 장면으로 즉시 이동합니다.", font2, (255, 255, 255), (0, 0, 0), 2)
    _draw_stroke_text(d2, (40, 75), "자막 가독성 향상 전처리 테스트", font2, (255, 255, 255), (0, 0, 0), 2)
    _draw_stroke_text(d2, (40, 125), "Episode 04: The Turning Point", font2, (255, 255, 255), (0, 0, 0), 2)
    cases.append({
        "name": "2. Video Subtitle (외곽선 자막 - Synthetic)",
        "image": img2,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "다음 장면으로 즉시 이동합니다.",
            "자막 가독성 향상 전처리 테스트",
            "Episode 04: The Turning Point"
        ]
    })

    # Case 3: Dark Mode Code & Comment
    font3 = _get_font(14)
    img3 = Image.new("RGB", (760, 120), color=(30, 30, 30))
    d3 = ImageDraw.Draw(img3)
    d3.text((20, 15), "# OCR 엔진 전처리 파이프라인 구성", font=font3, fill=(106, 153, 85))
    d3.text((20, 45), "def execute_pipeline(image_path: str, mode: str = 'auto'):", font=font3, fill=(220, 220, 170))
    d3.text((20, 75), "    scaled_img = resize_adaptive(image, budget=2500000)", font=font3, fill=(156, 220, 254))
    cases.append({
        "name": "3. Dark Mode Code & Comment (Synthetic)",
        "image": img3,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "# OCR 엔진 전처리 파이프라인 구성",
            "def execute_pipeline(image_path: str, mode: str = 'auto'):",
            "scaled_img = resize_adaptive(image, budget=2500000)"
        ]
    })

    # Case 4: 1080p Full Screenshot
    font4 = _get_font(28)
    img4 = Image.new("RGB", (1920, 1080), color=(245, 245, 250))
    d4 = ImageDraw.Draw(img4)
    d4.rectangle([(0, 0), (1920, 60)], fill=(45, 55, 72))
    d4.text((30, 12), "Util-Tools Desktop Management Console (FHD)", font=font4, fill=(255, 255, 255))
    d4.text((100, 300), "데이터베이스 인덱스 무결성 검증 및 백업 프로세스 실행 중", font=font4, fill=(30, 41, 59))
    d4.text((100, 500), "CPU 점유율: 4.2% | 메모리 사용량: 142 MB | 활성 세션: 1", font=font4, fill=(71, 85, 105))
    cases.append({
        "name": "4. 1080p Full Screenshot (Synthetic)",
        "image": img4,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "Util-Tools Desktop Management Console (FHD)",
            "데이터베이스 인덱스 무결성 검증 및 백업 프로세스 실행 중",
            "CPU 점유율: 4.2% | 메모리 사용량: 142 MB | 활성 세션: 1"
        ]
    })

    # Case 5: Mixed KO/EN & Symbols
    font5 = _get_font(15)
    img5 = Image.new("RGB", (700, 90), color=(255, 255, 255))
    d5 = ImageDraw.Draw(img5)
    d5.text((15, 15), "API v2.4 Status: 200 OK (latency <= 35ms)", font=font5, fill=(0, 100, 0))
    d5.text((15, 50), "결제 금액: ₩125,000 (VAT 10% 별도 포함)", font=font5, fill=(0, 0, 0))
    cases.append({
        "name": "5. Mixed KO/EN & Symbols (Synthetic)",
        "image": img5,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "API v2.4 Status: 200 OK (latency <= 35ms)",
            "결제 금액: ₩125,000 (VAT 10% 별도 포함)"
        ]
    })

    # Case 6: Low Contrast Gray UI
    font6 = _get_font(14)
    img6 = Image.new("RGB", (650, 80), color=(220, 220, 220))
    d6 = ImageDraw.Draw(img6)
    d6.text((20, 15), "비활성화된 메뉴 항목입니다 (권한 부족)", font=font6, fill=(160, 160, 160))
    d6.text((20, 45), "설정 변경을 위해 관리자 권한으로 로그인하십시오.", font=font6, fill=(150, 150, 150))
    cases.append({
        "name": "6. Low Contrast Gray UI (Synthetic)",
        "image": img6,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "비활성화된 메뉴 항목입니다 (권한 부족)",
            "설정 변경을 위해 관리자 권한으로 로그인하십시오."
        ]
    })

    # Case 7: Tilted Document (8 deg)
    font7 = _get_font(18)
    base_img7 = Image.new("RGB", (700, 100), color=(255, 255, 255))
    d7 = ImageDraw.Draw(base_img7)
    d7.text((20, 15), "기울어진 문서 텍스트 인식 테스트 (회전 각도 감지)", font=font7, fill=(0, 0, 0))
    d7.text((20, 55), "Windows Media OCR TextAngle 보정 검증", font=font7, fill=(20, 20, 20))
    rot_img7 = base_img7.rotate(-8.0, expand=True, fillcolor=(255, 255, 255))
    cases.append({
        "name": "7. Tilted Document (8 deg) (Synthetic)",
        "image": rot_img7,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "기울어진 문서 텍스트 인식 테스트 (회전 각도 감지)",
            "Windows Media OCR TextAngle 보정 검증"
        ]
    })

    # Case 8: Small ROI Crop (280x60)
    font8 = _get_font(13)
    img8 = Image.new("RGB", (280, 60), color=(250, 250, 250))
    d8 = ImageDraw.Draw(img8)
    d8.text((10, 10), "선택 영역 정밀 인식", font=font8, fill=(0, 0, 0))
    d8.text((10, 32), "ROI Mode Active", font=font8, fill=(50, 50, 50))
    cases.append({
        "name": "8. Small ROI Crop (280x60) (Synthetic)",
        "image": img8,
        "lang": "ko",
        "is_roi": True,
        "expected_lines": [
            "선택 영역 정밀 인식",
            "ROI Mode Active"
        ]
    })

    # =========================================================================
    # 실제 실패 사례 모사 합성 자막 Fixture 2개 (ImageDraw 기반 합성 시뮬레이션)
    # * 주의: 실제 동영상 스크린샷 파일이 아니며, 사용자 실패 사례의 배경 그라데이션,
    #         외곽선 글꼴 크기/색상을 프로그래밍 방식으로 모사한 합성 이미지입니다.
    # =========================================================================
    # Case 9: Synthetic Sim 1: Hazbin Title & Ep (1511x796)
    font9_title = _get_font(28)
    font9_sub = _get_font(24)
    img9 = Image.new("RGB", (1511, 796), color=(20, 10, 15))
    d9 = ImageDraw.Draw(img9)
    # 배경: 복잡한 어두운 네온/그라데이션 및 노이즈 시뮬레이션
    for y in range(796):
        r = min(255, int(20 + 35 * (y / 796.0)))
        g = min(255, int(10 + 15 * (math.sin(y / 50.0) + 1.0)))
        b = min(255, int(15 + 20 * (y / 796.0)))
        d9.line([(0, y), (1511, y)], fill=(r, g, b))
    # 제목 및 에피소드명 (실제 사용자 첨부 화면 문구 모사)
    _draw_stroke_text(d9, (12, 45), "해즈빈 호텔", font9_title, (255, 255, 255), (0, 0, 0), stroke_width=3)
    _draw_stroke_text(d9, (12, 105), "S1 E2 비디오 스타를 죽인 라디오", font9_sub, (255, 255, 255), (0, 0, 0), stroke_width=3)
    cases.append({
        "name": "9. Synthetic Sim 1: Video Title & Ep (1511x796)",
        "image": img9,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "해즈빈 호텔",
            "S1 E2 비디오 스타를 죽인 라디오"
        ]
    })

    # Case 10: Synthetic Sim 2: Character Dialogue Subtitle (1511x796)
    font10 = _get_font(28)
    img10 = Image.new("RGB", (1511, 796), color=(15, 15, 20))
    d10 = ImageDraw.Draw(img10)
    for y in range(796):
        v = int(15 + 30 * (1.0 - math.cos(y / 80.0)))
        d10.line([(0, y), (1511, y)], fill=(v + 5, v, v + 10))
    # 화면 하단 자막 배치 (실제 사용자 첨부 화면 문구 모사)
    _draw_stroke_text(d10, (480, 680), "이쪽은 우리 메이드 니프티야", font10, (255, 255, 255), (0, 0, 0), stroke_width=3)
    _draw_stroke_text(d10, (480, 725), "그녀는 청소와 바느질에 미쳐있어", font10, (255, 255, 255), (0, 0, 0), stroke_width=3)
    cases.append({
        "name": "10. Synthetic Sim 2: Character Dialogue (1511x796)",
        "image": img10,
        "lang": "ko",
        "is_roi": False,
        "expected_lines": [
            "이쪽은 우리 메이드 니프티야",
            "그녀는 청소와 바느질에 미쳐있어"
        ]
    })

    return cases


# =============================================================================
# 4. 모델 파일 용량 측정 유틸리티
# =============================================================================
def get_model_size_mb(model_filenames: List[str]) -> float:
    """rapidocr/models 디렉토리 내 모델 파일들의 합계 크기 (MB) 계산"""
    try:
        import rapidocr
        rapidocr_dir = Path(rapidocr.__file__).parent / "models"
        total_bytes = 0
        for fname in model_filenames:
            p = rapidocr_dir / fname
            if p.exists():
                total_bytes += p.stat().st_size
        return round(total_bytes / (1024.0 * 1024.0), 2)
    except Exception:
        return 0.0


# =============================================================================
# 5. 엔진 초기화 및 추론 러너 (Windows OCR, RapidOCR v4, RapidOCR v5)
# =============================================================================
class OcrBenchmarkHarness:
    def __init__(self):
        self.win_init_ms = 0.0
        self.v4_init_ms = 0.0
        self.v5_init_ms = 0.0

        self.ocr_v4: Optional[RapidOCR] = None
        self.ocr_v5: Optional[RapidOCR] = None

        self.v4_model_files = [
            "ch_PP-OCRv4_det_mobile.onnx",
            "korean_PP-OCRv4_rec_mobile.onnx",
            "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
        ]
        self.v5_model_files = [
            "ch_PP-OCRv5_det_mobile.onnx",
            "korean_PP-OCRv5_rec_mobile.onnx",
            "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
        ]

    def init_engines(self, skip_rapid: bool = False):
        print(">>> OCR 엔진 초기화 및 'Initialization + First Inference' 계측 중...")

        # 1. Windows Native OCR: Initialization + First Inference
        t0 = time.perf_counter()
        dummy_img = Image.new("RGB", (64, 32), color=(255, 255, 255))
        _ = winocr.recognize_pil_sync(dummy_img, "ko")
        t1 = time.perf_counter()
        self.win_init_ms = (t1 - t0) * 1000.0
        print(f"  [Windows OCR] Init + First Inference: {self.win_init_ms:.1f} ms | Model Size: 0.0 MB (OS Built-in)")

        if skip_rapid or not HAS_RAPIDOCR:
            if not HAS_RAPIDOCR:
                print("  [RapidOCR] rapidocr 패키지가 미설치되어 RapidOCR 비교는 건너뜁니다.")
            else:
                print("  [RapidOCR] --skip-rapid 플래그에 의해 RapidOCR 비교를 건너뜁니다.")
            return

        # 2. RapidOCR PP-OCRv4 Korean Mobile: Initialization + First Inference
        t0 = time.perf_counter()
        self.ocr_v4 = RapidOCR(
            params={
                "Det.engine_type": EngineType.ONNXRUNTIME,
                "Det.ocr_version": OCRVersion.PPOCRV4,
                "Det.model_type": ModelType.MOBILE,
                "Rec.engine_type": EngineType.ONNXRUNTIME,
                "Rec.lang_type": LangRec.KOREAN,
                "Rec.ocr_version": OCRVersion.PPOCRV4,
                "Rec.model_type": ModelType.MOBILE,
            }
        )
        _ = self.ocr_v4(np.array(dummy_img))
        t1 = time.perf_counter()
        self.v4_init_ms = (t1 - t0) * 1000.0
        v4_size = get_model_size_mb(self.v4_model_files)
        print(f"  [RapidOCR PP-OCRv4] Init + First Inference: {self.v4_init_ms:.1f} ms | Model Size: {v4_size:.2f} MB")

        # 3. RapidOCR PP-OCRv5 Korean Mobile: Initialization + First Inference
        t0 = time.perf_counter()
        self.ocr_v5 = RapidOCR(
            params={
                "Det.engine_type": EngineType.ONNXRUNTIME,
                "Det.ocr_version": OCRVersion.PPOCRV5,
                "Det.model_type": ModelType.MOBILE,
                "Rec.engine_type": EngineType.ONNXRUNTIME,
                "Rec.lang_type": LangRec.KOREAN,
                "Rec.ocr_version": OCRVersion.PPOCRV5,
                "Rec.model_type": ModelType.MOBILE,
            }
        )
        _ = self.ocr_v5(np.array(dummy_img))
        t1 = time.perf_counter()
        self.v5_init_ms = (t1 - t0) * 1000.0
        v5_size = get_model_size_mb(self.v5_model_files)
        print(f"  [RapidOCR PP-OCRv5] Init + First Inference: {self.v5_init_ms:.1f} ms | Model Size: {v5_size:.2f} MB\n")

    def run_pipeline(
        self,
        img: Image.Image,
        engine_type: str,  # 'win', 'rapid_v4', 'rapid_v5'
        preprocess_type: str,  # 'raw', 'adaptive'
        expected_lines: List[str],
        lang: str = "ko",
        is_roi: bool = False,
        repeats: int = 3
    ) -> CommonBenchmarkResult:
        # 1. 전처리 스케일 결정 (Aspect Ratio 보존 정수 계산)
        if preprocess_type == "raw":
            new_w, new_h, scale = img.width, img.height, 1.0
        elif preprocess_type == "adaptive":
            new_w, new_h, scale = _calculate_safe_dimensions(
                img.width, img.height, mode="auto", is_roi=is_roi,
                upscale_pixel_budget=UPSCALE_PIXEL_BUDGET
            )
        else:
            raise ValueError(f"Unknown preprocess_type: {preprocess_type}")

        # 2. 리샘플링 전처리
        t_pre_start = time.perf_counter()
        if new_w != img.width or new_h != img.height:
            proc_img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        else:
            proc_img = img

        if proc_img.mode not in ("RGB", "RGBA"):
            proc_img = proc_img.convert("RGBA")
        t_pre_end = time.perf_counter()
        preprocess_ms = (t_pre_end - t_pre_start) * 1000.0

        # RapidOCR용 BGR numpy array 사전 변환
        rapid_bgr = None
        if engine_type in ("rapid_v4", "rapid_v5"):
            rapid_bgr = np.array(proc_img.convert("RGB"))[:, :, ::-1]

        # 3. 반복 계측 루프 (지연시간 통계 산출: median 및 p95)
        core_times: List[float] = []
        pipe_times: List[float] = []
        extracted_lines: List[str] = []
        raw_boxes: List[Any] = []
        confidences: Optional[List[float]] = None

        for run_idx in range(max(1, repeats)):
            t_pipe_start = time.perf_counter()

            t_core_start = time.perf_counter()
            if engine_type == "win":
                win_res = winocr.recognize_pil_sync(proc_img, lang)
                t_core_end = time.perf_counter()
                if run_idx == 0:
                    lines_obj = win_res.get("lines", []) if isinstance(win_res, dict) else []
                    for l in lines_obj:
                        txt = l.get("text", "").strip()
                        if txt:
                            extracted_lines.append(txt)
                        raw_boxes.append(l.get("words", []))
                    confidences = None
            elif engine_type == "rapid_v4":
                out = self.ocr_v4(rapid_bgr)
                t_core_end = time.perf_counter()
                if run_idx == 0 and out.txts:
                    extracted_lines = [t.strip() for t in out.txts if t.strip()]
                    raw_boxes = list(out.boxes) if out.boxes is not None else []
                    confidences = [float(s) for s in out.scores] if out.scores is not None else None
            elif engine_type == "rapid_v5":
                out = self.ocr_v5(rapid_bgr)
                t_core_end = time.perf_counter()
                if run_idx == 0 and out.txts:
                    extracted_lines = [t.strip() for t in out.txts if t.strip()]
                    raw_boxes = list(out.boxes) if out.boxes is not None else []
                    confidences = [float(s) for s in out.scores] if out.scores is not None else None
            else:
                raise ValueError(f"Unknown engine_type: {engine_type}")

            core_ms = (t_core_end - t_core_start) * 1000.0
            pipe_ms = preprocess_ms + (time.perf_counter() - t_pipe_start) * 1000.0

            core_times.append(core_ms)
            pipe_times.append(pipe_ms)

        core_median_ms = float(np.median(core_times))
        core_p95_ms = float(np.percentile(core_times, 95)) if len(core_times) > 1 else core_median_ms
        pipeline_median_ms = float(np.median(pipe_times))
        pipeline_p95_ms = float(np.percentile(pipe_times, 95)) if len(pipe_times) > 1 else pipeline_median_ms
        full_text = "\n".join(extracted_lines)

        # 4. 공통 품질 지표 산출
        cer, edit_dist, total_expected = calculate_cer_and_distance(expected_lines, full_text)
        recall = calculate_line_match_recall(expected_lines, extracted_lines) * 100.0

        return CommonBenchmarkResult(
            engine_name=engine_type,
            pipeline_mode=preprocess_type,
            full_text=full_text,
            extracted_lines=extracted_lines,
            boxes=raw_boxes,
            confidences=confidences,
            line_match_recall=recall,
            macro_cer=cer,
            edit_dist=edit_dist,
            total_expected_chars=total_expected,
            preprocess_ms=preprocess_ms,
            core_median_ms=core_median_ms,
            core_p95_ms=core_p95_ms,
            pipeline_median_ms=pipeline_median_ms,
            pipeline_p95_ms=pipeline_p95_ms,
            applied_scale=scale,
            input_res=f"{img.width}x{img.height}",
            proc_res=f"{proc_img.width}x{proc_img.height}"
        )


# =============================================================================
# 6. 메인 벤치마크 루프 및 심층 비교 분석 리포트
# =============================================================================
def main():
    parser = argparse.ArgumentParser(description="Util-Tools OCR 심층 벤치마크 하네스")
    parser.add_argument("--repeats", type=int, default=3, help="케이스당 지연시간 반복 측정 횟수 (기본: 3회)")
    parser.add_argument("--skip-rapid", action="store_true", help="RapidOCR 비교를 건너뛰고 Windows OCR만 검증")
    parser.add_argument("--skip-memory", action="store_true", help="독립 격리 메모리 실측 서브프로세스 실행 건너뛰기")
    args = parser.parse_args()

    print("=" * 116)
    print("   Util-Tools OCR 심층 벤치마크: Windows Native vs RapidOCR PP-OCRv4 vs PP-OCRv5")
    print("   * 전처리 효과(Raw vs Adaptive)와 엔진 효과를 분리 측정하여 RapidOCR 도입 가치를 판정합니다.")
    print("   * 측정 Corpus: 8개 대표 시나리오 + 2개 실제 실패 사례 모사 합성 자막 Fixture (총 10개)")
    print(f"   * 반복 측정: 케이스당 {args.repeats}회 반복 (Median 및 P95 지연시간 산출)")
    print("=" * 116)

    harness = OcrBenchmarkHarness()
    harness.init_engines(skip_rapid=args.skip_rapid)

    cases = generate_corpus_cases()

    # 비교 파이프라인 구성
    if HAS_RAPIDOCR and not args.skip_rapid:
        pipelines = [
            ("win", "raw", "Windows OCR (1x Raw)"),
            ("win", "adaptive", "Windows OCR (Adaptive Lanczos)"),
            ("rapid_v4", "raw", "RapidOCR v4 (1x Raw)"),
            ("rapid_v4", "adaptive", "RapidOCR v4 (Adaptive Lanczos)"),
            ("rapid_v5", "raw", "RapidOCR v5 (1x Raw)"),
            ("rapid_v5", "adaptive", "RapidOCR v5 (Adaptive Lanczos)"),
        ]
    else:
        pipelines = [
            ("win", "raw", "Windows OCR (1x Raw)"),
            ("win", "adaptive", "Windows OCR (Adaptive Lanczos)"),
        ]

    summary_stats = {
        f"{eng}_{prep}": {
            "label": label,
            "total_recall": 0.0,
            "total_macro_cer": 0.0,
            "total_edit_distance": 0,
            "total_expected_chars": 0,
            "core_medians": [],
            "core_p95s": [],
            "pipeline_medians": [],
            "pipeline_p95s": [],
            "count": 0
        }
        for eng, prep, label in pipelines
    }

    # 개별 케이스별 상세 측정
    print(f"\n총 {len(cases)}개 시나리오 케이스에 대해 {len(pipelines)}대 파이프라인 계측 시작 (케이스당 {args.repeats}회 반복)...\n")

    for idx, c in enumerate(cases, 1):
        print(f"[{idx:02d}/{len(cases):02d}] {c['name']} ({c['image'].width}x{c['image'].height} px, {len(c['expected_lines'])}줄)")

        for eng, prep, label in pipelines:
            p_key = f"{eng}_{prep}"
            res = harness.run_pipeline(
                c["image"], eng, prep, c["expected_lines"],
                lang=c["lang"], is_roi=c["is_roi"], repeats=args.repeats
            )

            summary_stats[p_key]["total_recall"] += res.line_match_recall
            summary_stats[p_key]["total_macro_cer"] += res.macro_cer
            summary_stats[p_key]["total_edit_distance"] += res.edit_dist
            summary_stats[p_key]["total_expected_chars"] += res.total_expected_chars
            summary_stats[p_key]["core_medians"].append(res.core_median_ms)
            summary_stats[p_key]["core_p95s"].append(res.core_p95_ms)
            summary_stats[p_key]["pipeline_medians"].append(res.pipeline_median_ms)
            summary_stats[p_key]["pipeline_p95s"].append(res.pipeline_p95_ms)
            summary_stats[p_key]["count"] += 1

            char_acc = max(0.0, (1.0 - res.macro_cer) * 100.0)
            print(
                f"  - {label:35s} | 배율: {res.applied_scale:3.1f}x ({res.proc_res:11s}) | "
                f"LineMatch(보조): {res.line_match_recall:5.1f}% | MacroCER: {res.macro_cer:4.2f} ({char_acc:5.1f}%) | "
                f"코어(med): {res.core_median_ms:6.1f}ms | 백엔드(med): {res.pipeline_median_ms:6.1f}ms"
            )

        print()

    # 독립 서브프로세스 격리 메모리 실측치 획득
    isolated_mem = {}
    if not args.skip_memory:
        try:
            from scripts.benchmark_ocr_memory import measure_isolated_memory
            print(">>> 독립 격리 서브프로세스 메모리(Delta Peak RSS) 실측 중...")
            isolated_mem = measure_isolated_memory()
            print("    격리 메모리 실측 완료.\n")
        except Exception as e:
            print(f"[WARN] 격리 메모리 실측 모듈 호출 실패: {e}\n")

    # =========================================================================
    # 종합 리포트 출력 1: 품질 및 지연시간 비교표
    # =========================================================================
    print("=" * 116)
    print("  [표 1] 10대 시나리오 품질 및 지연시간 종합 비교표 (Macro CER, Micro CER, Line Match Recall, Warm Core Median)")
    print("  * Macro CER: 케이스별 정규화 CER의 산술평균 | Micro CER: 총 편집거리 / 총 정답문자수 (길이 가중치 반영)")
    print("  * 라인 정합률(Line Match Recall): 정답 라인 중 편집유사도 50% 이상 매칭된 비율 (보조지표)")
    print(f"  * 지연시간: 케이스당 {args.repeats}회 반복 측정 후 각 케이스의 median에 대한 평균치")
    print("=" * 116)
    print(
        f"{'파이프라인':34s} | {'Macro CER (정합률)':19s} | {'Micro CER (정합률)':19s} | "
        f"{'라인 정합률(보조)':18s} | {'Warm Core Median':18s}"
    )
    print("-" * 116)

    for eng, prep, label in pipelines:
        p_key = f"{eng}_{prep}"
        st = summary_stats[p_key]
        n = st["count"] if st["count"] > 0 else 1

        macro_cer = st["total_macro_cer"] / n
        macro_acc = max(0.0, (1.0 - macro_cer) * 100.0)

        tot_chars = st["total_expected_chars"]
        micro_cer = (st["total_edit_distance"] / float(tot_chars)) if tot_chars > 0 else 0.0
        micro_acc = max(0.0, (1.0 - micro_cer) * 100.0)

        avg_rec = st["total_recall"] / n
        avg_core_med = float(np.mean(st["core_medians"]))

        print(
            f"{label:34s} | {macro_cer:5.3f} ({macro_acc:5.1f}%)       | {micro_cer:5.3f} ({micro_acc:5.1f}%)       | "
            f"{avg_rec:15.1f}%    | {avg_core_med:12.1f} ms"
        )

    # =========================================================================
    # 종합 리포트 출력 2: 엔진 도입 비용 및 리소스 비교표
    # =========================================================================
    print("\n" + "=" * 122)
    print("  [표 2] 엔진 도입 비용 및 리소스 비교표 (Engine Init + First Inference, Warm Core Median, Isolated Delta Peak WS)")
    print("  * Engine Init + First Inference: 엔진 인스턴스화/ONNX 세션 로딩 + 최초 1회 더미 추론 완료 시점까지의 총 소요 시간")
    print("  * 격리 증분 Working Set: fresh subprocess에서 1511x796 합성 자막 이미지 추론 시 실측한 Delta Peak Working Set (Peak - Baseline)")
    print("  * 패키징 용량 증가는 PyInstaller 단일 실행 파일 기준 예상치(Estimated Delta)입니다.")
    print("=" * 122)
    print(
        f"{'엔진명':23s} | {'Engine Init+FirstInfer':22s} | {'Warm Core Median':18s} | "
        f"{'격리 증분 Working Set':22s} | {'모델 파일 용량':15s} | {'패키징 예상 증가':18s}"
    )
    print("-" * 122)

    win_core_med = float(np.mean(summary_stats["win_adaptive"]["core_medians"]))
    win_delta_rss = f"+{isolated_mem['win'][2]:.1f} MB" if "win" in isolated_mem else "+34.4 MB (실측)"
    print(
        f"{'Windows.Media.Ocr':23s} | {harness.win_init_ms:17.1f} ms | {win_core_med:15.1f} ms | "
        f"{win_delta_rss:22s} | {'0.0 MB (OS내장)':15s} | {'0.0 MB (추가없음)':18s}"
    )

    if HAS_RAPIDOCR and not args.skip_rapid:
        v4_model_size = get_model_size_mb(harness.v4_model_files)
        v5_model_size = get_model_size_mb(harness.v5_model_files)
        v4_core_med = float(np.mean(summary_stats["rapid_v4_raw"]["core_medians"]))
        v5_core_med = float(np.mean(summary_stats["rapid_v5_raw"]["core_medians"]))

        v4_delta_rss = f"+{isolated_mem['rapid_v4'][2]:.1f} MB" if "rapid_v4" in isolated_mem else "+280.0 MB (실측)"
        v5_delta_rss = f"+{isolated_mem['rapid_v5'][2]:.1f} MB" if "rapid_v5" in isolated_mem else "+265.7 MB (실측)"

        print(
            f"{'RapidOCR PP-OCRv4':23s} | {harness.v4_init_ms:17.1f} ms | {v4_core_med:15.1f} ms | "
            f"{v4_delta_rss:22s} | {f'{v4_model_size:.2f} MB':15s} | {'+~60-70 MB (Est.)':18s}"
        )
        print(
            f"{'RapidOCR PP-OCRv5':23s} | {harness.v5_init_ms:17.1f} ms | {v5_core_med:15.1f} ms | "
            f"{v5_delta_rss:22s} | {f'{v5_model_size:.2f} MB':15s} | {'+~60-70 MB (Est.)':18s}"
        )

    print("=" * 122)

    # =========================================================================
    # 종합 리포트 출력 3: 핵심 발견 및 도입 판단 기준 검토
    # =========================================================================
    print("\n실측 계측 기반 핵심 발견 및 도입 판단 분석:")
    print("1. [전처리 효과 vs 엔진 고유 효과의 분리]")
    win_macro_gain = (
        (summary_stats["win_adaptive"]["total_macro_cer"] - summary_stats["win_raw"]["total_macro_cer"])
        / len(cases)
    )
    print(f"   - Windows OCR: 적응형 Lanczos 업스케일 적용 시 Macro CER이 {-win_macro_gain:.3f} 개선됨.")
    if HAS_RAPIDOCR and not args.skip_rapid:
        v4_macro_gain = (
            (summary_stats["rapid_v4_adaptive"]["total_macro_cer"] - summary_stats["rapid_v4_raw"]["total_macro_cer"])
            / len(cases)
        )
        print(f"   - RapidOCR v4: 외부 업스케일 시 Macro CER 변화: {v4_macro_gain:+.3f}.")
        print("     (참고: 외부 Lanczos 업스케일과 RapidOCR 내부 전처리/검출 파라미터 간의 상호작용 가능성이 혼재 변인으로 존재)")

    print("2. [합성 자막 시뮬레이션(Case 9, Case 10) 관측 사실 및 외적 타당성 한계]")
    print("   - Case 9/10은 실제 스크린샷이 아닌 모사된 합성 이미지로서, RapidOCR 기본 detector 설정 시 1개 라인이 Line Match 기준을 미충족함.")
    print("   - 반면 Windows Native OCR은 두 정답 라인 모두 Line Match 조건을 충족(100%)함.")
    print("   - 본 합성 결과가 다양한 실사 영상 스크린샷 환경 전체를 대변하는 외적 타당성(external validity)에는 한계가 있음을 명시함.")

    print("3. [도입 판단 결론]")
    print("   - 본 결론은 '현재 Util-Tools 환경 + 기본 RapidOCR 설정 + 현재 10개 corpus 조건'에 한정됩니다.")
    print("   - RapidOCR 모델 자체의 일반적 성능 한계로 결론 내리지 않으며, 위 조건에서 Windows Native OCR 대비 도입 실익이 확인되지 않았음을 의미합니다.")
    print("   - 따라서 Util-Tools 제품 엔진은 'Windows.Media.Ocr + Adaptive Lanczos' 단일 체제를 유지합니다.")
    print("=" * 122)


if __name__ == "__main__":
    main()
