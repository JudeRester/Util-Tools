"""
services/ocr_service.py - Windows.Media.Ocr 기반 로컬 OCR(광학 문자 인식) 서비스 모듈
- 기본 엔진: Windows.Media.Ocr.OcrEngine (Windows 10/11 빌트인)
- Python 구현 브리지: winocr (WinRT 비동기 호출 및 Pillow 비트맵 변환)
- 런타임 언어 capability 검사 (ko-KR, en-US) 및 미설치 시 Windows 설정 가이드 제공
- Word Bounding Box Union 기반 Line Bounding Box 산출
- ROI (관심 영역) Crop -> OCR 재인식 -> 원본 좌표 오프셋 복원
- 실측 지연시간(latency_ms) 계측
- 디스크 기반 썸네일(data/ocr/thumbnails/thumb_{id}.jpg) 저장 및 Bottle 썸네일 스트리밍
"""

import os
import io
import time
import math
import json
import uuid
import base64
import secrets
import threading
import traceback
from typing import List, Dict, Any, Optional, Tuple

from bottle import BaseRequest, request, response
from PIL import Image
import eel
import winocr
from winrt.windows.media.ocr import OcrEngine
from winrt.windows.globalization import Language

from core.paths import (
    APP_DIR,
    DATA_DIR,
    DB_PATH,
    OCR_DIR,
    OCR_THUMBS_DIR
)
from core.logger import log_event
from services.db_service import get_db_connection

class _LoggerAdapter:
    def info(self, msg: str, details: str = ""):
        log_event("info", "OCR", msg, details)
    def error(self, msg: str, details: str = ""):
        log_event("error", "OCR", msg, details)
    def warning(self, msg: str, details: str = ""):
        log_event("warn", "OCR", msg, details)

logger = _LoggerAdapter()

# ==============================================================================
# 1. 초기 디렉토리 생성
# ==============================================================================
def _ensure_ocr_dirs():
    os.makedirs(OCR_DIR, exist_ok=True)
    os.makedirs(OCR_THUMBS_DIR, exist_ok=True)

_ensure_ocr_dirs()

# ==============================================================================
# 1. Transport 버퍼링 및 Source Registry (Opaque Handle 기반 수명주기 관리)
# ==============================================================================
BaseRequest.MEMFILE_MAX = 50 * 1024 * 1024  # 인메모리 버퍼링 임계치 (50MB)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024        # 실제 업로드 상한선 (25MB, 초과 시 HTTP 413)
MAX_IMAGE_DIMENSION = 10000                 # 최대 가로/세로 픽셀 한도
MAX_TOTAL_PIXELS = 30_000_000               # 최대 총 픽셀 한도 (30M px)
ALLOWED_IMAGE_FORMATS = {"PNG", "JPEG", "JPG", "WEBP", "BMP", "TIFF"}

# 프로세스 격리 세션 토큰 (로컬 CSRF 및 비인가 루프백 POST 완벽 차단)
OCR_SESSION_TOKEN = secrets.token_hex(16)


def _is_safe_local_request(require_token: bool = False) -> bool:
    """루프백 IP, 로컬 호스트 및 세션 토큰 검증 (Same-Origin / Loopback / CSRF 방어)"""
    client_ip = request.environ.get("REMOTE_ADDR", "")
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        return False
    host = request.headers.get("Host", "")
    if not (host.startswith("localhost") or host.startswith("127.0.0.1")):
        return False
    sec_fetch_site = request.headers.get("Sec-Fetch-Site", "")
    if sec_fetch_site and sec_fetch_site not in ("same-origin", "none", "same-site"):
        return False
    if require_token:
        token = request.headers.get("X-UtilTools-Token", "")
        if not token or not secrets.compare_digest(token, OCR_SESSION_TOKEN):
            return False
    return True


def _json_error_response(status_code: int, error_code: str, message: str) -> str:
    """프론트엔드-백엔드 간 표준화된 HTTP 에러 JSON 응답 조립"""
    response.status = status_code
    response.content_type = "application/json; charset=utf-8"
    return json.dumps({
        "success": False,
        "error_code": error_code,
        "message": message,
        "error": message
    }, ensure_ascii=False)


class OcrSource:
    """단일 이미지 소스에 대한 안전한 인메모리/파일 핸들 메타데이터"""
    def __init__(
        self,
        source_id: str,
        source_type: str,
        file_path: Optional[str] = None,
        image_bytes: Optional[bytes] = None,
        filename: str = "image.png",
        width: int = 0,
        height: int = 0,
        format_name: str = "PNG"
    ):
        self.source_id = source_id
        self.source_type = source_type  # 'file' | 'blob'
        self.file_path = file_path
        self.image_bytes = image_bytes
        self.filename = filename
        self.width = width
        self.height = height
        self.format_name = format_name
        self.created_at = time.time()
        self.last_accessed = time.time()
        self._cached_image: Optional[Image.Image] = None

    def get_image(self) -> Image.Image:
        self.last_accessed = time.time()
        if self._cached_image is not None:
            return self._cached_image.copy()

        try:
            if self.source_type == "file" and self.file_path and os.path.exists(self.file_path):
                img = Image.open(self.file_path)
                img.load()
                self._cached_image = img
                return img.copy()
            elif self.image_bytes:
                img = Image.open(io.BytesIO(self.image_bytes))
                img.load()
                self._cached_image = img
                return img.copy()
            else:
                raise ValueError("이미지 데이터를 로드할 수 없습니다.")
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
            raise ValueError(f"DECOMPRESSION_BOMB: 비정상적인 초고해상도 이미지입니다 ({e})")


class OcrSourceRegistry:
    """
    최대 5개 소스, 30분 TTL, LRU 축출 정책을 적용한 소스 레지스트리
    로컬 파일의 실제 절대 경로는 백엔드에만 보관하고 프론트엔드에는 UUID만 노출합니다.
    """
    def __init__(self, max_sources: int = 5, ttl_seconds: int = 1800):
        self._sources: Dict[str, OcrSource] = {}
        self._lock = threading.Lock()
        self.max_sources = max_sources
        self.ttl_seconds = ttl_seconds

    def _cleanup_expired_locked(self):
        now = time.time()
        expired_ids = [
            sid for sid, src in self._sources.items()
            if now - src.last_accessed > self.ttl_seconds
        ]
        for sid in expired_ids:
            del self._sources[sid]

    def _evict_lru_locked(self):
        if len(self._sources) >= self.max_sources:
            lru_id = min(self._sources.keys(), key=lambda k: self._sources[k].last_accessed)
            del self._sources[lru_id]

    def register_file(self, file_path: str) -> OcrSource:
        with self._lock:
            self._cleanup_expired_locked()
            self._evict_lru_locked()

            if not os.path.exists(file_path):
                raise FileNotFoundError("파일을 찾을 수 없습니다.")

            stat = os.stat(file_path)
            if stat.st_size > MAX_UPLOAD_BYTES:
                raise ValueError(f"파일 크기 초과: {stat.st_size} bytes (최대 {MAX_UPLOAD_BYTES} bytes)")

            try:
                with Image.open(file_path) as test_img:
                    fmt = (test_img.format or "PNG").upper()
                    if fmt not in ALLOWED_IMAGE_FORMATS:
                        raise ValueError(f"UNSUPPORTED_FORMAT: 지원하지 않는 이미지 형식입니다 ({fmt}). PNG, JPG, WebP, BMP, TIFF를 사용하세요.")
                    w, h = test_img.size
                    if w > MAX_IMAGE_DIMENSION or h > MAX_IMAGE_DIMENSION:
                        raise ValueError(f"INVALID_IMAGE: 이미지 해상도 초과 ({w}x{h}px, 최대 {MAX_IMAGE_DIMENSION}px)")
                    if w * h > MAX_TOTAL_PIXELS:
                        raise ValueError(f"INVALID_IMAGE: 이미지 총 픽셀 수 초과 ({w * h}px, 최대 {MAX_TOTAL_PIXELS}px)")
                    test_img.load()
            except (Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
                raise ValueError(f"INVALID_IMAGE: 비정상적인 초고해상도(Decompression Bomb) 이미지입니다 ({e})")
            except Exception as e:
                if isinstance(e, ValueError):
                    raise
                raise ValueError(f"INVALID_IMAGE: 손상되었거나 열 수 없는 이미지 파일입니다 ({str(e)})")

            source_id = str(uuid.uuid4())
            src = OcrSource(
                source_id=source_id,
                source_type="file",
                file_path=file_path,
                filename=os.path.basename(file_path),
                width=w,
                height=h,
                format_name=fmt
            )
            self._sources[source_id] = src
            return src

    def register_blob(self, raw_bytes: bytes, filename: str = "clipboard.png") -> OcrSource:
        with self._lock:
            self._cleanup_expired_locked()
            self._evict_lru_locked()

            if len(raw_bytes) > MAX_UPLOAD_BYTES:
                raise ValueError(f"PAYLOAD_TOO_LARGE: 업로드 크기 초과 ({len(raw_bytes)/(1024*1024):.1f}MB, 최대 {MAX_UPLOAD_BYTES//(1024*1024)}MB)")

            try:
                with Image.open(io.BytesIO(raw_bytes)) as test_img:
                    fmt = (test_img.format or "PNG").upper()
                    if fmt not in ALLOWED_IMAGE_FORMATS:
                        raise ValueError(f"UNSUPPORTED_FORMAT: 지원하지 않는 이미지 형식입니다 ({fmt}). PNG, JPG, WebP, BMP, TIFF를 사용하세요.")
                    w, h = test_img.size
                    if w > MAX_IMAGE_DIMENSION or h > MAX_IMAGE_DIMENSION:
                        raise ValueError(f"INVALID_IMAGE: 이미지 해상도 초과 ({w}x{h}px, 최대 {MAX_IMAGE_DIMENSION}px)")
                    if w * h > MAX_TOTAL_PIXELS:
                        raise ValueError(f"INVALID_IMAGE: 이미지 총 픽셀 수 초과 ({w * h}px, 최대 {MAX_TOTAL_PIXELS}px)")
                    test_img.load()
            except (Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
                raise ValueError(f"INVALID_IMAGE: 비정상적인 초고해상도(Decompression Bomb) 이미지입니다 ({e})")
            except Exception as e:
                if isinstance(e, ValueError):
                    raise
                raise ValueError(f"INVALID_IMAGE: 손상되었거나 열 수 없는 이미지 데이터입니다 ({str(e)})")

            source_id = str(uuid.uuid4())
            src = OcrSource(
                source_id=source_id,
                source_type="blob",
                image_bytes=raw_bytes,
                filename=filename,
                width=w,
                height=h,
                format_name=fmt
            )
            self._sources[source_id] = src
            return src

    def get(self, source_id: str) -> Optional[OcrSource]:
        with self._lock:
            src = self._sources.get(source_id)
            if src:
                src.last_accessed = time.time()
            return src

    def delete(self, source_id: str) -> bool:
        with self._lock:
            if source_id in self._sources:
                del self._sources[source_id]
                return True
            return False

    def clear(self):
        with self._lock:
            self._sources.clear()

_source_registry = OcrSourceRegistry()


# ==============================================================================
# 2. 런타임 OCR 언어 Capability 검사
# ==============================================================================
def check_ocr_capabilities() -> Dict[str, Any]:
    """
    Windows 시스템에 ko-KR 및 en-US OCR 언어 capability가 설치되어 있는지 동적 확인
    """
    try:
        available_langs = [lang.language_tag for lang in OcrEngine.available_recognizer_languages]
        is_ko_supported = (
            OcrEngine.is_language_supported(Language("ko-KR")) or 
            OcrEngine.is_language_supported(Language("ko"))
        )
        is_en_supported = (
            OcrEngine.is_language_supported(Language("en-US")) or 
            OcrEngine.is_language_supported(Language("en"))
        )
        is_ready = is_ko_supported or is_en_supported

        guide_message = ""
        if not (is_ko_supported and is_en_supported):
            missing = []
            if not is_ko_supported:
                missing.append("한국어")
            if not is_en_supported:
                missing.append("영어")
            guide_message = (
                f"Windows 시스템에 {' / '.join(missing)} OCR 언어 팩이 설치되어 있지 않습니다. "
                "Windows 설정 > 시간 및 언어 > 언어 및 지역 > 언어 옵션에서 "
                "[광학 문자 인식(OCR)] 기능을 추가하시면 해당 언어의 텍스트 추출이 가능합니다."
            )

        return {
            "is_ready": is_ready,
            "is_ko_supported": is_ko_supported,
            "is_en_supported": is_en_supported,
            "available_languages": available_langs,
            "guide_message": guide_message
        }
    except Exception as e:
        logger.error(f"OCR 언어 capability 확인 실패: {e}\n{traceback.format_exc()}")
        return {
            "is_ready": False,
            "is_ko_supported": False,
            "is_en_supported": False,
            "available_languages": [],
            "guide_message": f"Windows OCR 서브시스템 초기화 오류: {str(e)}"
        }


def _resolve_win_language_tag(lang: str) -> str:
    """
    입력 언어 코드를 Windows OcrEngine 지원 태그로 정규화
    """
    lang_clean = (lang or "ko").strip().lower()
    if lang_clean.startswith("ko"):
        if OcrEngine.is_language_supported(Language("ko-KR")):
            return "ko-KR"
        if OcrEngine.is_language_supported(Language("ko")):
            return "ko"
        return "ko-KR"
    elif lang_clean.startswith("en"):
        if OcrEngine.is_language_supported(Language("en-US")):
            return "en-US"
        if OcrEngine.is_language_supported(Language("en")):
            return "en"
        return "en-US"
    return lang


UPSCALE_PIXEL_BUDGET = 2_500_000  # 업스케일링 적용 상한 버짓 (약 1080p FHD 수준)


def _calculate_safe_dimensions(
    target_w: int,
    target_h: int,
    mode: str = "auto",
    is_roi: bool = False,
    upscale_pixel_budget: int = UPSCALE_PIXEL_BUDGET
) -> Tuple[int, int, float]:
    """
    1. Hard constraint: OcrEngine.max_image_dimension 초과 시 반드시 강제 downscale (엔진 오류 방어).
       부동소수점 scale을 round()하지 않고, 최종 정수 해상도(new_w, new_h)에서
       max(new_w, new_h) <= max_dim 불변식을 정수 차원에서 직접 강제(clamp).
    2. Optimization constraint: UPSCALE_PIXEL_BUDGET 초과 시 upscale만 제한 (다운스케일하지 않고 원본 1.0x 유지).
       업스케일 적용 시에도 정수 차원에서 new_w * new_h <= upscale_pixel_budget 불변식을 보장.

    Returns:
        (new_w, new_h, applied_scale)
    """
    max_dim = getattr(OcrEngine, "max_image_dimension", 2600)
    current_max = max(target_w, target_h)
    current_pixels = target_w * target_h

    if target_w <= 0 or target_h <= 0 or current_max <= 0:
        return 1, 1, 1.0

    # 1. Hard constraint (Windows OCR 단일 축 물리적 한계 초과 시 다운스케일)
    if current_max > max_dim:
        scale = max_dim / float(current_max)
        new_w = min(max_dim, max(1, int(math.floor(target_w * scale))))
        new_h = min(max_dim, max(1, int(math.floor(target_h * scale))))
        assert max(new_w, new_h) <= max_dim, f"Hard limit invariant violated: {max(new_w, new_h)} > {max_dim}"
        applied_scale = new_w / float(target_w)
        return new_w, new_h, applied_scale

    # 2. Hard constraint 만족 시: 1x 모드는 원본 유지
    if mode == "1x":
        return target_w, target_h, 1.0

    # 3. 업스케일 대상 (mode == '2x' or 'auto')
    target_scale = 2.0
    hard_limit_scale = max_dim / float(current_max)
    budget_scale = (float(upscale_pixel_budget) / float(current_pixels)) ** 0.5
    raw_scale = min(target_scale, hard_limit_scale, budget_scale)

    # 원본 이하(1.05 미만)로는 다운스케일하지 않고 원본 1.0x 유지
    if raw_scale < 1.05:
        return target_w, target_h, 1.0

    # 정수 치수 계산 (종횡비 보존 단일 비율 계산, 반복 1px 루프 제거)
    new_w = min(max_dim, max(1, int(math.floor(target_w * raw_scale))))
    new_h = min(max_dim, max(1, int(math.floor(target_h * raw_scale))))

    # 부동소수점 극단 오차로 인한 예산 초과 방어 (비율 유지 보정)
    if new_w * new_h > upscale_pixel_budget:
        adj_scale = raw_scale * (float(upscale_pixel_budget) / float(new_w * new_h)) ** 0.5
        new_w = min(max_dim, max(1, int(math.floor(target_w * adj_scale))))
        new_h = min(max_dim, max(1, int(math.floor(target_h * adj_scale))))

    # 만약 보정 과정에서 원본 이하로 떨어지면 안전하게 원본 유지
    if new_w < target_w or new_h < target_h:
        return target_w, target_h, 1.0

    # 최종 불변식 검증
    assert max(new_w, new_h) <= max_dim, f"Hard limit invariant violated: {max(new_w, new_h)} > {max_dim}"
    assert new_w * new_h <= max(current_pixels, upscale_pixel_budget), f"Budget invariant violated: {new_w * new_h} > {upscale_pixel_budget}"

    applied_scale = new_w / float(target_w)
    return new_w, new_h, applied_scale


def _calculate_safe_upscale_factor(
    target_w: int,
    target_h: int,
    mode: str = "auto",
    is_roi: bool = False,
    upscale_pixel_budget: int = UPSCALE_PIXEL_BUDGET
) -> float:
    """
    _calculate_safe_dimensions 결과를 기반으로 배율을 반환하는 래퍼 함수 (하위 호환성 유지)
    """
    _, _, scale = _calculate_safe_dimensions(
        target_w, target_h, mode=mode, is_roi=is_roi, upscale_pixel_budget=upscale_pixel_budget
    )
    return round(scale, 3)


# ==============================================================================
# 3. 코어 OCR 파이프라인 (ROI Crop -> Upscale -> OCR -> Offset/Scale 복원 -> Line Union)
# ==============================================================================
def _execute_ocr_pipeline(
    img: Image.Image,
    roi: Optional[Dict[str, Any]] = None,
    lang: str = "ko",
    scale_mode: str = "auto",
    rotation: int = 0
) -> Dict[str, Any]:
    """
    PIL Image에 대해 (회전 및 ROI 적용 후) 적응형 업스케일 및 Windows.Media.Ocr를 실행하고 Word/Line Union 좌표 복원.
    각 단계(전처리, OCR 코어, 후처리)별 소요시간을 정밀 분리 계측합니다.
    """
    t_start = time.perf_counter()

    if rotation % 360 != 0:
        rot_deg = rotation % 360
        # 시계 방향 각도(+90: 시계 방향)에 맞춰 PIL rotate(-rot_deg, expand=True) 적용
        img = img.rotate(-rot_deg, expand=True)

    orig_width, orig_height = img.width, img.height
    offset_x = 0
    offset_y = 0
    target_img = img
    is_roi = False

    # 1. ROI 적용 여부 확인 및 물리적 크롭 & 전처리 시작
    t_pre_start = time.perf_counter()
    if roi and isinstance(roi, dict):
        rx = int(round(roi.get("x", 0)))
        ry = int(round(roi.get("y", 0)))
        rw = int(round(roi.get("width", roi.get("w", 0))))
        rh = int(round(roi.get("height", roi.get("h", 0))))

        # 유효 범위 클램핑
        rx = max(0, min(rx, orig_width - 1))
        ry = max(0, min(ry, orig_height - 1))
        rw = max(1, min(rw, orig_width - rx))
        rh = max(1, min(rh, orig_height - ry))

        target_img = img.crop((rx, ry, rx + rw, ry + rh))
        offset_x = rx
        offset_y = ry
        is_roi = True

    # 2. 안전한 해상도 동적 계산 (Hard Limit Clamp & Upscale Pixel Budget Invariant)
    new_w, new_h, applied_scale = _calculate_safe_dimensions(
        target_img.width, target_img.height, mode=scale_mode, is_roi=is_roi
    )

    if new_w != target_img.width or new_h != target_img.height:
        ocr_input_img = target_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    else:
        ocr_input_img = target_img

    # 3. Pillow 이미지 포맷 정규화 (RGBA 또는 RGB)
    if ocr_input_img.mode not in ("RGB", "RGBA"):
        ocr_input_img = ocr_input_img.convert("RGBA")

    t_pre_end = time.perf_counter()
    preprocess_ms = round((t_pre_end - t_pre_start) * 1000.0, 1)

    # 4. 언어 태그 해석 및 순수 Windows OCR 코어 실행
    target_lang = _resolve_win_language_tag(lang)
    try:
        lang_obj = Language(target_lang)
        if not OcrEngine.is_language_supported(lang_obj):
            raise ValueError(f"OCR_LANGUAGE_UNAVAILABLE: Windows OCR 엔진에 '{target_lang}' 언어 팩이 설치되어 있지 않습니다.")
    except Exception as e:
        if isinstance(e, ValueError) and "OCR_LANGUAGE_UNAVAILABLE" in str(e):
            raise
        raise ValueError(f"OCR_LANGUAGE_UNAVAILABLE: 유효하지 않거나 지원되지 않는 언어입니다 ('{target_lang}': {e})")

    t_core_start = time.perf_counter()
    raw_result = winocr.recognize_pil_sync(ocr_input_img, target_lang)
    t_core_end = time.perf_counter()
    core_ocr_ms = round((t_core_end - t_core_start) * 1000.0, 1)

    # 5. 블록 및 바운딩 박스 파싱 (적용된 배율로 나눈 후 오프셋 가산하여 원본 좌표로 복원)
    t_post_start = time.perf_counter()
    text_angle = raw_result.get("text_angle") if isinstance(raw_result, dict) else None
    raw_lines = raw_result.get("lines", []) if isinstance(raw_result, dict) else []
    blocks = []

    applied_scale_x = float(new_w) / float(target_img.width)
    applied_scale_y = float(new_h) / float(target_img.height)

    for line_obj in raw_lines:
        line_text = line_obj.get("text", "")
        raw_words = line_obj.get("words", [])
        line_words = []

        for w in raw_words:
            w_text = w.get("text", "")
            w_rect = w.get("bounding_rect", {})

            # 실제 적용된 scale(x, y)로 역변환하여 원본 1x 픽셀 좌표계로 복원
            wx = (float(w_rect.get("x", 0)) / applied_scale_x) + offset_x
            wy = (float(w_rect.get("y", 0)) / applied_scale_y) + offset_y
            ww = float(w_rect.get("width", 0)) / applied_scale_x
            wh = float(w_rect.get("height", 0)) / applied_scale_y

            line_words.append({
                "text": w_text,
                "x": round(wx, 1),
                "y": round(wy, 1),
                "width": round(ww, 1),
                "height": round(wh, 1)
            })

        # Line Bounding Box: 복원된 Word BBox들의 Union (최소 외접 직사각형)
        if line_words:
            line_min_x = min(w["x"] for w in line_words)
            line_min_y = min(w["y"] for w in line_words)
            line_max_x = max(w["x"] + w["width"] for w in line_words)
            line_max_y = max(w["y"] + w["height"] for w in line_words)
            line_w = line_max_x - line_min_x
            line_h = line_max_y - line_min_y
        else:
            line_min_x = offset_x
            line_min_y = offset_y
            line_w = 0.0
            line_h = 0.0

        blocks.append({
            "text": line_text,
            "x": round(line_min_x, 1),
            "y": round(line_min_y, 1),
            "width": round(line_w, 1),
            "height": round(line_h, 1),
            "words": line_words
        })

    # 추출된 전체 텍스트 조합
    extracted_text = "\n".join(b["text"] for b in blocks if b["text"].strip())
    if not extracted_text and isinstance(raw_result, dict):
        extracted_text = raw_result.get("text", "").strip()

    t_post_end = time.perf_counter()
    postprocess_ms = round((t_post_end - t_post_start) * 1000.0, 1)
    pipeline_total_ms = round((t_post_end - t_start) * 1000.0, 1)

    timings = {
        "preprocess_ms": preprocess_ms,
        "core_ocr_ms": core_ocr_ms,
        "postprocess_ms": postprocess_ms,
        "pipeline_total_ms": pipeline_total_ms
    }

    return {
        "text": extracted_text,
        "blocks": blocks,
        "image_width": orig_width,
        "image_height": orig_height,
        "latency_ms": pipeline_total_ms,
        "core_ocr_ms": core_ocr_ms,
        "timings": timings,
        "roi": roi if roi else None,
        "scale_applied": applied_scale,
        "text_angle": text_angle
    }


# ==============================================================================
# 4. 썸네일 생성 및 디스크 저장 매니저
# ==============================================================================
def _create_and_save_thumbnail(img: Image.Image, history_id: int) -> str:
    """
    원본 이미지로부터 160px 비율 유지 썸네일 JPEG를 생성하여 디스크에 저장
    """
    try:
        thumb = img.copy()
        thumb.thumbnail((160, 160), Image.Resampling.LANCZOS)

        if thumb.mode in ("RGBA", "LA", "P"):
            bg = Image.new("RGB", thumb.size, (255, 255, 255))
            if thumb.mode == "RGBA":
                bg.paste(thumb, mask=thumb.split()[3])
            else:
                bg.paste(thumb.convert("RGBA"))
            thumb = bg
        elif thumb.mode != "RGB":
            thumb = thumb.convert("RGB")

        file_name = f"thumb_{history_id}.jpg"
        file_path = os.path.join(OCR_THUMBS_DIR, file_name)
        thumb.save(file_path, "JPEG", quality=85)
        return file_path
    except Exception as e:
        logger.error(f"썸네일 생성 실패 (id={history_id}): {e}")
        return ""


def _save_ocr_history_record(
    source_type: str,
    filename: str,
    img: Image.Image,
    extracted_text: str,
    blocks: List[Dict[str, Any]],
    latency_ms: float
) -> int:
    """
    SQLite ocr_history 테이블에 인식 결과 레코드를 저장하고 디스크 썸네일 경로를 갱신
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        blocks_json = json.dumps(blocks, ensure_ascii=False)
        cur.execute("""
            INSERT INTO ocr_history (
                source_type, filename, image_width, image_height,
                extracted_text, blocks_json, thumbnail_path, latency_ms
            ) VALUES (?, ?, ?, ?, ?, ?, '', ?)
        """, (
            source_type,
            filename or "",
            img.width,
            img.height,
            extracted_text or "",
            blocks_json,
            latency_ms
        ))
        history_id = cur.lastrowid
        conn.commit()

        # 디스크 썸네일 생성 및 경로 업데이트
        thumb_path = _create_and_save_thumbnail(img, history_id)
        if thumb_path:
            conn.execute(
                "UPDATE ocr_history SET thumbnail_path = ? WHERE id = ?",
                (thumb_path, history_id)
            )
            conn.commit()

        return history_id
    except Exception as e:
        logger.error(f"OCR 히스토리 저장 실패: {e}\n{traceback.format_exc()}")
        return 0
    finally:
        conn.close()


# ==============================================================================
# 5. Bottle 엔드포인트 (썸네일 & Source Transport API)
# ==============================================================================
@eel.btl.route("/api/ocr/thumb/<thumb_id:int>")
def get_ocr_thumbnail(thumb_id: int):
    """
    디스크에 저장된 OCR 썸네일 이미지 스트리밍
    """
    file_name = f"thumb_{thumb_id}.jpg"
    file_path = os.path.join(OCR_THUMBS_DIR, file_name)
    if not os.path.exists(file_path):
        return eel.btl.HTTPError(404, "Thumbnail not found")
    return eel.btl.static_file(file_name, root=OCR_THUMBS_DIR)


@eel.btl.route("/api/ocr/source/<source_id>/preview")
def get_ocr_source_preview(source_id: str):
    """
    source_id에 해당하는 원본 이미지 바이너리 프리뷰 스트리밍
    (TIFF 등 브라우저 비표준 포맷 또는 회전 요청 시 동적 변환 제공)
    """
    if not _is_safe_local_request():
        return _json_error_response(403, "INVALID_SESSION", "접근이 거부되었습니다.")

    src = _source_registry.get(source_id)
    if not src:
        return _json_error_response(404, "SOURCE_EXPIRED", "이미지 세션이 만료되었습니다. 이미지를 다시 열어주세요.")

    try:
        rotation = int(request.query.get("rotation", 0)) % 360
    except (ValueError, TypeError):
        rotation = 0

    fmt = src.format_name.upper()
    need_convert = (fmt not in ("PNG", "JPEG", "JPG", "WEBP", "BMP")) or (rotation != 0)

    if need_convert:
        img = src.get_image()
        if rotation != 0:
            img = img.rotate(-rotation, expand=True)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        response.content_type = "image/png"
        return buf.getvalue()

    if src.source_type == "file" and src.file_path and os.path.exists(src.file_path):
        dirname = os.path.dirname(os.path.abspath(src.file_path))
        filename = os.path.basename(src.file_path)
        return eel.btl.static_file(filename, root=dirname)
    elif src.image_bytes:
        mime = f"image/{fmt.lower()}" if fmt.lower() in ("png", "jpeg", "webp", "bmp") else "image/png"
        response.content_type = mime
        return src.image_bytes
    else:
        return _json_error_response(404, "SOURCE_EXPIRED", "이미지 바이너리를 찾을 수 없습니다.")


@eel.btl.route("/api/ocr/source", method=["POST", "OPTIONS"])
def handle_ocr_source_upload():
    """
    로컬 HTTP Binary Multipart Transport 엔드포인트
    클립보드/드래그앤드롭 바이너리를 수신하여 Source Registry에 등록하고
    1회차 OCR 추론을 단일 왕복(Single Round-Trip)으로 동시 수행합니다.
    """
    if request.method == "OPTIONS":
        return {}
    if not _is_safe_local_request(require_token=True):
        return _json_error_response(403, "INVALID_SESSION", "접근이 거부되었습니다 (유효하지 않은 로컬 세션 토큰).")

    content_length = request.content_length
    if content_length and content_length > MAX_UPLOAD_BYTES:
        return _json_error_response(413, "PAYLOAD_TOO_LARGE", f"이미지 업로드 용량이 상한선({MAX_UPLOAD_BYTES // (1024*1024)}MB)을 초과했습니다.")

    t_entry = time.perf_counter()
    upload = request.files.get("file")
    if not upload:
        raw_bytes = request.body.read(MAX_UPLOAD_BYTES + 1)
        if len(raw_bytes) > MAX_UPLOAD_BYTES:
            return _json_error_response(413, "PAYLOAD_TOO_LARGE", f"이미지 업로드 용량이 상한선({MAX_UPLOAD_BYTES // (1024*1024)}MB)을 초과했습니다.")
        filename = request.headers.get("X-Filename", "clipboard.png")
    else:
        raw_bytes = upload.file.read(MAX_UPLOAD_BYTES + 1)
        if len(raw_bytes) > MAX_UPLOAD_BYTES:
            return _json_error_response(413, "PAYLOAD_TOO_LARGE", f"이미지 업로드 용량이 상한선({MAX_UPLOAD_BYTES // (1024*1024)}MB)을 초과했습니다.")
        filename = upload.filename or "image.png"

    if not raw_bytes:
        return _json_error_response(400, "INVALID_IMAGE", "전송된 이미지 데이터가 비어 있습니다.")

    try:
        t_reg_start = time.perf_counter()
        src = _source_registry.register_blob(raw_bytes, filename=filename)
        t_reg_end = time.perf_counter()
        register_ms = round((t_reg_end - t_reg_start) * 1000.0, 1)

        lang = request.forms.get("lang", "ko")
        roi_str = request.forms.get("roi", "")
        roi = json.loads(roi_str) if roi_str and roi_str.strip() else None
        try:
            rotation = int(request.forms.get("rotation", 0))
        except (ValueError, TypeError):
            rotation = 0
        save_history = request.forms.get("save_history", "true").lower() == "true"
        source_type = request.forms.get("source_type", "clipboard")

        img = src.get_image()
        ocr_res = _execute_ocr_pipeline(img, roi=roi, lang=lang, rotation=rotation)

        history_id = None
        if save_history and ocr_res["text"].strip():
            history_id = _save_ocr_history_record(
                source_type=source_type,
                filename=filename,
                img=img,
                extracted_text=ocr_res["text"],
                blocks=ocr_res["blocks"],
                latency_ms=ocr_res["latency_ms"]
            )

        total_backend_ms = round((time.perf_counter() - t_entry) * 1000.0, 1)
        timings = ocr_res.get("timings", {})
        timings["transport_register_ms"] = register_ms
        timings["backend_total_ms"] = total_backend_ms

        response.content_type = "application/json; charset=utf-8"
        return json.dumps({
            "success": True,
            "source_id": src.source_id,
            "filename": src.filename,
            "width": src.width,
            "height": src.height,
            "format": src.format_name,
            "text": ocr_res["text"],
            "blocks": ocr_res["blocks"],
            "latency_ms": total_backend_ms,
            "core_ocr_ms": timings.get("core_ocr_ms", 0.0),
            "timings": timings,
            "roi": ocr_res["roi"],
            "scale_applied": ocr_res["scale_applied"],
            "text_angle": ocr_res["text_angle"],
            "history_id": history_id
        }, ensure_ascii=False)
    except Exception as e:
        err_msg = str(e)
        logger.error(f"Multipart 소스 등록 및 OCR 실패: {err_msg}\n{traceback.format_exc()}")
        if "PAYLOAD_TOO_LARGE" in err_msg:
            return _json_error_response(413, "PAYLOAD_TOO_LARGE", err_msg)
        elif "UNSUPPORTED_FORMAT" in err_msg:
            return _json_error_response(415, "UNSUPPORTED_FORMAT", err_msg)
        elif "INVALID_IMAGE" in err_msg or "DECOMPRESSION_BOMB" in err_msg or "cannot identify" in err_msg:
            return _json_error_response(400, "INVALID_IMAGE", err_msg)
        elif "OCR_LANGUAGE_UNAVAILABLE" in err_msg:
            return _json_error_response(422, "OCR_LANGUAGE_UNAVAILABLE", err_msg)
        elif "SOURCE_EXPIRED" in err_msg:
            return _json_error_response(404, "SOURCE_EXPIRED", err_msg)
        else:
            return _json_error_response(500, "OCR_FAILED", f"OCR 처리 중 오류가 발생했습니다: {err_msg}")


@eel.btl.route("/api/ocr/source/<source_id>", method=["DELETE"])
def delete_ocr_source_endpoint(source_id: str):
    if not _is_safe_local_request(require_token=True):
        return _json_error_response(403, "INVALID_SESSION", "접근이 거부되었습니다.")
    deleted = _source_registry.delete(source_id)
    if not deleted:
        return _json_error_response(404, "SOURCE_EXPIRED", "만료되었거나 존재하지 않는 소스입니다.")
    return {"success": True}


# ==============================================================================
# 6. Eel RPC Expose 함수 목록
# ==============================================================================
@eel.expose
def open_ocr_file_dialog() -> Dict[str, Any]:
    """
    백엔드 네이티브 Windows 파일 선택 대화상자(tkinter)
    선택된 파일의 실제 경로는 백엔드 Source Registry에만 보관하고,
    프론트엔드에는 안전한 opaque source_id 및 이미지 메타데이터만 반환합니다.
    """
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        file_selected = filedialog.askopenfilename(
            title="인식할 이미지 파일 선택",
            filetypes=[
                ("이미지 파일", "*.png;*.jpg;*.jpeg;*.bmp;*.webp;*.tiff"),
                ("모든 파일", "*.*")
            ]
        )
        root.destroy()

        if not file_selected:
            return {"status": "cancelled", "source_id": ""}

        norm_path = os.path.normpath(file_selected)
        src = _source_registry.register_file(norm_path)

        return {
            "status": "success",
            "source_id": src.source_id,
            "filename": src.filename,
            "width": src.width,
            "height": src.height,
            "format": src.format_name
        }
    except Exception as e:
        err_msg = str(e)
        logger.error(f"open_ocr_file_dialog 실패: {err_msg}\n{traceback.format_exc()}")
        error_code = "OCR_FAILED"
        if "PAYLOAD_TOO_LARGE" in err_msg or "파일 크기 초과" in err_msg:
            error_code = "PAYLOAD_TOO_LARGE"
        elif "UNSUPPORTED_FORMAT" in err_msg:
            error_code = "UNSUPPORTED_FORMAT"
        elif "INVALID_IMAGE" in err_msg or "DECOMPRESSION_BOMB" in err_msg:
            error_code = "INVALID_IMAGE"
        return {"status": "error", "error_code": error_code, "message": err_msg, "error": err_msg}


@eel.expose
def recognize_ocr_source(
    source_id: str,
    lang: str = "ko",
    roi: Optional[Dict[str, Any]] = None,
    rotation: int = 0,
    save_history: bool = True
) -> Dict[str, Any]:
    """
    등록된 source_id에 대해 (ROI, 회전 적용 후) OCR 실행/재실행
    이미지 데이터 재전송 없이 O(1) 인메모리로 처리됩니다.
    """
    t_entry = time.perf_counter()
    src = _source_registry.get(source_id)
    if not src:
        return {
            "success": False,
            "error_code": "SOURCE_EXPIRED",
            "error": "유효하지 않거나 만료된 source_id입니다. 이미지를 다시 로드해주세요."
        }

    try:
        img = src.get_image()
        ocr_res = _execute_ocr_pipeline(img, roi=roi, lang=lang, rotation=rotation)

        history_id = None
        if save_history and ocr_res["text"].strip():
            history_id = _save_ocr_history_record(
                source_type=src.source_type,
                filename=src.filename,
                img=img,
                extracted_text=ocr_res["text"],
                blocks=ocr_res["blocks"],
                latency_ms=ocr_res["latency_ms"]
            )

        total_backend_ms = round((time.perf_counter() - t_entry) * 1000.0, 1)
        timings = ocr_res.get("timings", {})
        timings["backend_total_ms"] = total_backend_ms

        return {
            "success": True,
            "source_id": src.source_id,
            "filename": src.filename,
            "width": src.width,
            "height": src.height,
            "text": ocr_res["text"],
            "blocks": ocr_res["blocks"],
            "latency_ms": total_backend_ms,
            "core_ocr_ms": timings.get("core_ocr_ms", 0.0),
            "timings": timings,
            "roi": ocr_res["roi"],
            "scale_applied": ocr_res["scale_applied"],
            "text_angle": ocr_res["text_angle"],
            "history_id": history_id
        }
    except Exception as e:
        err_msg = str(e)
        logger.error(f"recognize_ocr_source 실패 (source_id={source_id}): {err_msg}\n{traceback.format_exc()}")
        error_code = "OCR_FAILED"
        if "PAYLOAD_TOO_LARGE" in err_msg:
            error_code = "PAYLOAD_TOO_LARGE"
        elif "UNSUPPORTED_FORMAT" in err_msg:
            error_code = "UNSUPPORTED_FORMAT"
        elif "INVALID_IMAGE" in err_msg or "DECOMPRESSION_BOMB" in err_msg or "cannot identify" in err_msg:
            error_code = "INVALID_IMAGE"
        elif "OCR_LANGUAGE_UNAVAILABLE" in err_msg:
            error_code = "OCR_LANGUAGE_UNAVAILABLE"
        elif "SOURCE_EXPIRED" in err_msg:
            error_code = "SOURCE_EXPIRED"
        return {"success": False, "error_code": error_code, "error": err_msg}


@eel.expose
def clear_ocr_sources() -> Dict[str, Any]:
    """Source Registry 내 모든 소스 메모리 해제"""
    _source_registry.clear()
    return {"success": True}


@eel.expose
def get_ocr_capabilities() -> Dict[str, Any]:
    """프론트엔드에 Windows OCR 엔진 및 언어 지원 상태 반환"""
    return check_ocr_capabilities()


@eel.expose
def get_ocr_session_token() -> str:
    """프론트엔드에 프로세스 범위 격리 세션 토큰 반환"""
    return OCR_SESSION_TOKEN


@eel.expose
def recognize_ocr_base64(
    base64_data: str,
    roi: Optional[Dict[str, Any]] = None,
    lang: str = "ko",
    filename: str = "",
    source_type: str = "clipboard",
    save_history: bool = True,
    scale_mode: str = "auto"
) -> Dict[str, Any]:
    """
    Base64 인코딩된 이미지 데이터(클립보드, 이미지 슬라이서 등)에 대해 OCR 수행
    단계별 지연시간(디코딩, 전처리/업스케일, OCR 코어, 후처리, DB/썸네일)을 분리 계측합니다.
    """
    t_entry = time.perf_counter()
    try:
        if not base64_data:
            return {"success": False, "error": "이미지 데이터가 비어 있습니다."}

        # data:image/png;base64,... 헤더 제거
        if "," in base64_data:
            base64_data = base64_data.split(",", 1)[1]

        t_dec_start = time.perf_counter()
        image_bytes = base64.b64decode(base64_data)
        img = Image.open(io.BytesIO(image_bytes))
        t_dec_end = time.perf_counter()
        decode_ms = round((t_dec_end - t_dec_start) * 1000.0, 1)

        result = _execute_ocr_pipeline(img, roi=roi, lang=lang, scale_mode=scale_mode)

        t_hist_start = time.perf_counter()
        history_id = None
        if save_history and result["text"].strip():
            history_id = _save_ocr_history_record(
                source_type=source_type,
                filename=filename or ("clipboard.png" if source_type == "clipboard" else "slice.png"),
                img=img,
                extracted_text=result["text"],
                blocks=result["blocks"],
                latency_ms=result["latency_ms"]
            )
        t_hist_end = time.perf_counter()
        history_ms = round((t_hist_end - t_hist_start) * 1000.0, 1)

        backend_total_ms = round((time.perf_counter() - t_entry) * 1000.0, 1)

        pipeline_timings = result.get("timings", {})
        timings = {
            "decode_ms": decode_ms,
            "preprocess_ms": pipeline_timings.get("preprocess_ms", 0.0),
            "core_ocr_ms": pipeline_timings.get("core_ocr_ms", 0.0),
            "postprocess_ms": pipeline_timings.get("postprocess_ms", 0.0),
            "history_ms": history_ms,
            "backend_total_ms": backend_total_ms
        }

        return {
            "success": True,
            "text": result["text"],
            "blocks": result["blocks"],
            "image_width": result["image_width"],
            "image_height": result["image_height"],
            "latency_ms": backend_total_ms,
            "core_ocr_ms": pipeline_timings.get("core_ocr_ms", 0.0),
            "timings": timings,
            "roi": result["roi"],
            "scale_applied": result["scale_applied"],
            "text_angle": result["text_angle"],
            "history_id": history_id
        }
    except Exception as e:
        logger.error(f"Base64 OCR 처리 실패: {e}\n{traceback.format_exc()}")
        return {"success": False, "error": f"OCR 처리 중 오류가 발생했습니다: {str(e)}"}


@eel.expose
def recognize_ocr_file(
    file_path: str,
    roi: Optional[Dict[str, Any]] = None,
    lang: str = "ko",
    save_history: bool = True,
    scale_mode: str = "auto"
) -> Dict[str, Any]:
    """
    로컬 이미지 파일 경로를 직접 읽어 OCR 수행
    단계별 지연시간(파일IO, 전처리/업스케일, OCR 코어, 후처리, DB/썸네일)을 분리 계측합니다.
    """
    t_entry = time.perf_counter()
    try:
        if not file_path or not os.path.exists(file_path):
            return {"success": False, "error": "파일을 찾을 수 없습니다."}

        t_io_start = time.perf_counter()
        img = Image.open(file_path)
        t_io_end = time.perf_counter()
        file_io_ms = round((t_io_end - t_io_start) * 1000.0, 1)

        result = _execute_ocr_pipeline(img, roi=roi, lang=lang, scale_mode=scale_mode)

        t_hist_start = time.perf_counter()
        history_id = None
        if save_history and result["text"].strip():
            history_id = _save_ocr_history_record(
                source_type="file",
                filename=os.path.basename(file_path),
                img=img,
                extracted_text=result["text"],
                blocks=result["blocks"],
                latency_ms=result["latency_ms"]
            )
        t_hist_end = time.perf_counter()
        history_ms = round((t_hist_end - t_hist_start) * 1000.0, 1)

        backend_total_ms = round((time.perf_counter() - t_entry) * 1000.0, 1)

        pipeline_timings = result.get("timings", {})
        timings = {
            "file_io_ms": file_io_ms,
            "preprocess_ms": pipeline_timings.get("preprocess_ms", 0.0),
            "core_ocr_ms": pipeline_timings.get("core_ocr_ms", 0.0),
            "postprocess_ms": pipeline_timings.get("postprocess_ms", 0.0),
            "history_ms": history_ms,
            "backend_total_ms": backend_total_ms
        }

        return {
            "success": True,
            "text": result["text"],
            "blocks": result["blocks"],
            "image_width": result["image_width"],
            "image_height": result["image_height"],
            "latency_ms": backend_total_ms,
            "core_ocr_ms": pipeline_timings.get("core_ocr_ms", 0.0),
            "timings": timings,
            "roi": result["roi"],
            "scale_applied": result["scale_applied"],
            "text_angle": result["text_angle"],
            "history_id": history_id
        }
    except Exception as e:
        logger.error(f"파일 OCR 처리 실패 ({file_path}): {e}\n{traceback.format_exc()}")
        return {"success": False, "error": f"파일 OCR 처리 중 오류가 발생했습니다: {str(e)}"}


@eel.expose
def get_ocr_history(limit: int = 50) -> List[Dict[str, Any]]:
    """OCR 인식 이력 목록 조회"""
    conn = get_db_connection()
    try:
        rows = conn.execute("""
            SELECT id, source_type, filename, image_width, image_height,
                   extracted_text, blocks_json, thumbnail_path, latency_ms, created_at
            FROM ocr_history
            ORDER BY created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()

        items = []
        for r in rows:
            items.append({
                "id": r["id"],
                "source_type": r["source_type"],
                "filename": r["filename"],
                "image_width": r["image_width"],
                "image_height": r["image_height"],
                "extracted_text": r["extracted_text"],
                "blocks": json.loads(r["blocks_json"]) if r["blocks_json"] else [],
                "thumbnail_url": f"/api/ocr/thumb/{r['id']}" if r["thumbnail_path"] else "",
                "latency_ms": r["latency_ms"],
                "created_at": r["created_at"]
            })
        return items
    except Exception as e:
        logger.error(f"OCR 히스토리 조회 실패: {e}")
        return []
    finally:
        conn.close()


@eel.expose
def delete_ocr_history(history_id: int) -> Dict[str, Any]:
    """특정 OCR 히스토리 및 디스크 썸네일 삭제"""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT thumbnail_path FROM ocr_history WHERE id = ?", (history_id,)).fetchone()
        if row and row["thumbnail_path"] and os.path.exists(row["thumbnail_path"]):
            try:
                os.remove(row["thumbnail_path"])
            except Exception:
                pass

        conn.execute("DELETE FROM ocr_history WHERE id = ?", (history_id,))
        conn.commit()
        return {"success": True}
    except Exception as e:
        logger.error(f"OCR 히스토리 삭제 실패 (id={history_id}): {e}")
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


@eel.expose
def clear_ocr_history() -> Dict[str, Any]:
    """모든 OCR 히스토리 및 썸네일 파일 완전 삭제"""
    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM ocr_history;")
        conn.commit()

        # 디스크 썸네일 디렉토리 내 파일 일괄 삭제
        if os.path.exists(OCR_THUMBS_DIR):
            for fname in os.listdir(OCR_THUMBS_DIR):
                fpath = os.path.join(OCR_THUMBS_DIR, fname)
                if os.path.isfile(fpath):
                    try:
                        os.remove(fpath)
                    except Exception:
                        pass
        return {"success": True}
    except Exception as e:
        logger.error(f"OCR 히스토리 전체 삭제 실패: {e}")
        return {"success": False, "error": str(e)}
    finally:
        conn.close()
