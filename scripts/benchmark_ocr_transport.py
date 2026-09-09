"""
scripts/benchmark_ocr_transport.py
Util-Tools OCR 전송 계층(Transport Layer) 심층 성능 비교 벤치마크 하네스:
1) Base64 WebSocket RPC (Legacy 모드 시뮬레이션)
2) Native File Dialog (Source Registry Opaque Handle 모드)
3) Local HTTP Binary Multipart Transport (Source Registry 단일 왕복 모드)
4) Secondary Operation (ROI 부분 영역 크롭 / 90° 회전 재인식 시 0-전송 효과 검증)

동일한 1511x796 및 1920x1080 이미지 Fixture에 대해 각 5회 반복 계측을 수행하고,
Median 기준의 컴포넌트별 지연시간 및 E2E 지연시간, 페이로드 오버헤드를 정량적으로 산출합니다.
"""

import os
import sys
import io
import time
import math
import json
import socket
import argparse
import base64
import statistics
import threading
import urllib.request
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional

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

import eel
from services.ocr_service import (
    _source_registry,
    _execute_ocr_pipeline,
    recognize_ocr_base64,
    recognize_ocr_source,
    recognize_ocr_file,
    OCR_SESSION_TOKEN
)


# =============================================================================
# 1. 폰트 로더 및 Fixture 생성 유틸리티
# =============================================================================
def _get_font(size: int = 24) -> ImageFont.FreeTypeFont:
    candidate_fonts = [
        "C:\\Windows\\Fonts\\malgun.ttf",
        "C:\\Windows\\Fonts\\malgunbd.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
        "C:\\Windows\\Fonts\\segoeui.ttf",
    ]
    for fp in candidate_fonts:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _draw_stroke_text(draw, pos, text, font, fill, stroke_fill, stroke_width=2):
    x, y = pos
    for dx in range(-stroke_width, stroke_width + 1):
        for dy in range(-stroke_width, stroke_width + 1):
            if dx * dx + dy * dy <= stroke_width * stroke_width:
                draw.text((x + dx, y + dy), text, font=font, fill=stroke_fill)
    draw.text((x, y), text, font=font, fill=fill)


def generate_benchmark_fixtures(tmp_dir: Path) -> List[Dict[str, Any]]:
    """
    대표 시나리오 3종 Fixture 생성:
    1) 1511x796 Synthetic Video Subtitle (동영상 자막 시나리오)
    2) 1920x1080 FHD Desktop Screenshot (데스크톱 콘솔 화면 시나리오)
    3) 1920x1080 High-Entropy Noise Texture (고용량 4~5MB 전송 스트레스 시나리오)
    """
    tmp_dir.mkdir(parents=True, exist_ok=True)
    fixtures = []

    # -------------------------------------------------------------------------
    # Fixture 1: 1511x796 Synthetic Video Subtitle (Realistic 2.4MB Texture)
    # -------------------------------------------------------------------------
    font_title = _get_font(28)
    font_sub = _get_font(24)
    font_dialogue = _get_font(28)
    rng = np.random.default_rng(42)
    # 실제 영상의 센서 노이즈 및 질감 모사 (PNG 압축 시 약 2.4MB)
    arr1 = np.zeros((796, 1511, 3), dtype=np.uint8)
    for y in range(796):
        r = min(255, int(20 + 35 * (y / 796.0)))
        g = min(255, int(10 + 15 * (math.sin(y / 50.0) + 1.0)))
        b = min(255, int(15 + 20 * (y / 796.0)))
        arr1[y, :, 0] = r
        arr1[y, :, 1] = g
        arr1[y, :, 2] = b
    noise1 = rng.integers(0, 28, (796, 1511, 3), dtype=np.uint8)
    arr1 = np.clip(arr1.astype(np.int16) + noise1, 0, 255).astype(np.uint8)
    img1 = Image.fromarray(arr1)

    d1 = ImageDraw.Draw(img1)
    _draw_stroke_text(d1, (12, 45), "해즈빈 호텔", font_title, (255, 255, 255), (0, 0, 0), stroke_width=3)
    _draw_stroke_text(d1, (12, 105), "S1 E2 비디오 스타를 죽인 라디오", font_sub, (255, 255, 255), (0, 0, 0), stroke_width=3)
    _draw_stroke_text(d1, (480, 710), "이쪽은 우리 메이드 니프티야", font_dialogue, (255, 255, 255), (0, 0, 0), stroke_width=3)

    path1 = tmp_dir / "fixture_1511x796_subtitle.png"
    img1.save(path1, format="PNG")
    buf1 = io.BytesIO()
    img1.save(buf1, format="PNG")
    bytes1 = buf1.getvalue()
    fixtures.append({
        "id": "1511x796_subtitle",
        "name": "1. 1511x796 Video Subtitle (Realistic Texture)",
        "width": 1511,
        "height": 796,
        "image": img1,
        "file_path": str(path1),
        "raw_bytes": bytes1,
        "raw_size_mb": len(bytes1) / (1024.0 * 1024.0)
    })

    # -------------------------------------------------------------------------
    # Fixture 2: 1920x1080 FHD Desktop Screenshot (Realistic 3.6MB Detail)
    # -------------------------------------------------------------------------
    font_fhd_title = _get_font(30)
    font_fhd_body = _get_font(20)
    arr2 = np.full((1080, 1920, 3), 245, dtype=np.uint8)
    noise2 = rng.integers(0, 25, (1080, 1920, 3), dtype=np.uint8)
    arr2 = np.clip(arr2.astype(np.int16) - noise2, 0, 255).astype(np.uint8)
    img2 = Image.fromarray(arr2)

    d2 = ImageDraw.Draw(img2)
    d2.rectangle([(0, 0), (1920, 60)], fill=(45, 55, 72))
    d2.text((30, 12), "Util-Tools Desktop Management Console (FHD 1080p)", font=font_fhd_title, fill=(255, 255, 255))
    d2.text((100, 300), "데이터베이스 인덱스 무결성 검증 및 백업 프로세스 실행 중", font=font_fhd_body, fill=(30, 41, 59))
    d2.text((100, 450), "CPU 점유율: 4.2% | 메모리 사용량: 142 MB | 활성 세션: 1", font=font_fhd_body, fill=(71, 85, 105))
    d2.text((100, 600), "Windows Media OCR Native Engine Transport 최적화 검증", font=font_fhd_body, fill=(15, 23, 42))

    path2 = tmp_dir / "fixture_1920x1080_desktop.png"
    img2.save(path2, format="PNG")
    buf2 = io.BytesIO()
    img2.save(buf2, format="PNG")
    bytes2 = buf2.getvalue()
    fixtures.append({
        "id": "1920x1080_desktop",
        "name": "2. 1920x1080 Desktop Screenshot (Realistic Detail)",
        "width": 1920,
        "height": 1080,
        "image": img2,
        "file_path": str(path2),
        "raw_bytes": bytes2,
        "raw_size_mb": len(bytes2) / (1024.0 * 1024.0)
    })

    # -------------------------------------------------------------------------
    # Fixture 3: 1920x1080 High-Entropy Noise (전송 부하 스트레스 테스트, ~5MB)
    # -------------------------------------------------------------------------
    rng = np.random.default_rng(42)
    noise_data = rng.integers(0, 256, (1080, 1920, 3), dtype=np.uint8)
    img3 = Image.fromarray(noise_data)
    d3 = ImageDraw.Draw(img3)
    d3.rectangle([(400, 450), (1520, 630)], fill=(0, 0, 0))
    d3.text((450, 480), "High-Entropy Transport Stress Test 5MB", font=font_fhd_title, fill=(255, 255, 255))
    d3.text((450, 550), "로컬 HTTP Binary vs Base64 대역폭 한계 계측", font=font_fhd_body, fill=(200, 240, 200))

    path3 = tmp_dir / "fixture_1920x1080_noise_stress.png"
    img3.save(path3, format="PNG")
    buf3 = io.BytesIO()
    img3.save(buf3, format="PNG")
    bytes3 = buf3.getvalue()
    fixtures.append({
        "id": "1920x1080_stress",
        "name": "3. 1920x1080 Noise Stress Test (~5MB)",
        "width": 1920,
        "height": 1080,
        "image": img3,
        "file_path": str(path3),
        "raw_bytes": bytes3,
        "raw_size_mb": len(bytes3) / (1024.0 * 1024.0)
    })

    return fixtures


# =============================================================================
# 2. 로컬 Bottle 서버 생명주기 관리 유틸리티
# =============================================================================
def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_test_server() -> Tuple[str, threading.Thread]:
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    app = eel.btl.default_app()

    server_thread = threading.Thread(
        target=lambda: app.run(host="127.0.0.1", port=port, quiet=True),
        daemon=True
    )
    server_thread.start()

    # 서버 준비 대기 (최대 3초)
    for _ in range(30):
        try:
            req = urllib.request.Request(f"{base_url}/api/ocr/source", method="OPTIONS")
            with urllib.request.urlopen(req, timeout=0.5) as resp:
                if resp.status == 200:
                    break
        except Exception:
            time.sleep(0.1)
    else:
        raise RuntimeError(f"로컬 테스트 서버 기동 실패 (Port: {port})")

    return base_url, server_thread


# =============================================================================
# 3. 전송 채널별 단일 실행 측정기
# =============================================================================
def run_channel_base64_legacy(raw_bytes: bytes) -> Dict[str, float]:
    """
    Channel 1: Base64 WebSocket RPC (Legacy)
    - 클라이언트 인코딩: base64.b64encode + data:image/png;base64,... 헤더 조립
    - 전송 페이로드: JSON 직렬화된 문자열 바이트
    - 서버 인입: Base64 디코딩 + OCR 파이프라인 수행
    """
    t_start = time.perf_counter()

    # 1. 클라이언트 측 DataURL 인코딩 (FileReader.readAsDataURL 시뮬레이션)
    t_enc_0 = time.perf_counter()
    b64_str = base64.b64encode(raw_bytes).decode("ascii")
    data_url = f"data:image/png;base64,{b64_str}"
    t_enc_1 = time.perf_counter()
    client_encode_ms = (t_enc_1 - t_enc_0) * 1000.0

    # 2. WebSocket RPC 직렬화 페이로드 크기 계산
    json_payload = json.dumps({"base64_data": data_url, "lang": "ko"}).encode("utf-8")
    wire_bytes = len(json_payload)

    # 3. 백엔드 함수 호출 (recognize_ocr_base64)
    t_rpc_0 = time.perf_counter()
    res = recognize_ocr_base64(
        base64_data=data_url,
        lang="ko",
        save_history=False
    )
    t_rpc_1 = time.perf_counter()
    rpc_elapsed_ms = (t_rpc_1 - t_rpc_0) * 1000.0
    e2e_ms = (t_rpc_1 - t_start) * 1000.0

    timings = res.get("timings", {})
    decode_ms = timings.get("decode_ms", 0.0)
    core_ocr_ms = timings.get("core_ocr_ms", 0.0)
    backend_total_ms = timings.get("backend_total_ms", rpc_elapsed_ms)

    return {
        "channel": "base64_legacy",
        "wire_bytes": wire_bytes,
        "wire_mb": wire_bytes / (1024.0 * 1024.0),
        "client_encode_ms": client_encode_ms,
        "transport_wire_ms": max(0.0, rpc_elapsed_ms - backend_total_ms),
        "server_ingest_ms": decode_ms,
        "core_ocr_ms": core_ocr_ms,
        "backend_total_ms": backend_total_ms,
        "e2e_ms": e2e_ms,
        "char_count": len(res.get("text", ""))
    }


def run_channel_native_handle(file_path: str) -> Dict[str, float]:
    """
    Channel 2: Native File Dialog (Source Registry)
    - 클라이언트 인코딩: 0ms
    - 전송 페이로드: 0 bytes (파일 경로는 백엔드에 보관되고 프론트에는 UUID만 전달)
    - 서버 인입: 파일 경로 레지스트리 등록 + 이미지 로드 + OCR 파이프라인
    """
    t_start = time.perf_counter()

    # 1. 파일 레지스트리 등록 (open_ocr_file_dialog 내부 로직)
    t_reg_0 = time.perf_counter()
    src = _source_registry.register_file(file_path)
    t_reg_1 = time.perf_counter()
    reg_ms = (t_reg_1 - t_reg_0) * 1000.0

    # 2. Opaque Handle(UUID)을 통한 인식 RPC 실행
    t_rpc_0 = time.perf_counter()
    res = recognize_ocr_source(
        source_id=src.source_id,
        lang="ko",
        save_history=False
    )
    t_rpc_1 = time.perf_counter()
    rpc_elapsed_ms = (t_rpc_1 - t_rpc_0) * 1000.0
    e2e_ms = (t_rpc_1 - t_start) * 1000.0

    timings = res.get("timings", {})
    core_ocr_ms = timings.get("core_ocr_ms", 0.0)
    backend_total_ms = timings.get("backend_total_ms", rpc_elapsed_ms)

    return {
        "channel": "native_handle",
        "source_id": src.source_id,
        "wire_bytes": 0,  # 이미지 데이터 0바이트 전송
        "wire_mb": 0.0,
        "client_encode_ms": 0.0,
        "transport_wire_ms": 0.0,
        "server_ingest_ms": reg_ms,
        "core_ocr_ms": core_ocr_ms,
        "backend_total_ms": backend_total_ms + reg_ms,
        "e2e_ms": e2e_ms,
        "char_count": len(res.get("text", ""))
    }


def run_channel_binary_multipart(base_url: str, raw_bytes: bytes, filename: str) -> Dict[str, float]:
    """
    Channel 3: Local HTTP Binary Multipart Transport (Source Registry)
    - 클라이언트 인코딩: 0ms (바이너리 Blob 직접 전송)
    - 전송 페이로드: raw_bytes + multipart header (~200B)
    - 서버 인입: POST /api/ocr/source 단일 왕복 (스트리밍 파싱 + 레지스트리 등록 + OCR 파이프라인)
    """
    t_start = time.perf_counter()

    # 1. 클라이언트 인코딩: 0ms (Blob 객체 생성은 0ms에 수렴)
    client_encode_ms = 0.0

    # 2. Multipart Body 조립 (브라우저 FormData의 실제 전송 형태)
    boundary = "----UtilToolsTransportBenchBoundary"
    header_part = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: image/png\r\n\r\n"
    ).encode("utf-8")
    extra_fields = (
        f"\r\n--{boundary}\r\n"
        f'Content-Disposition: form-data; name="lang"\r\n\r\nko\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="save_history"\r\n\r\nfalse\r\n'
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    multipart_body = header_part + raw_bytes + extra_fields
    wire_bytes = len(multipart_body)

    # 3. Local HTTP POST 단일 왕복 실행
    req = urllib.request.Request(
        f"{base_url}/api/ocr/source",
        data=multipart_body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Host": base_url.replace("http://", ""),
            "X-UtilTools-Token": OCR_SESSION_TOKEN
        },
        method="POST"
    )

    t_http_0 = time.perf_counter()
    with urllib.request.urlopen(req) as resp:
        resp_bytes = resp.read()
    t_http_1 = time.perf_counter()
    http_total_ms = (t_http_1 - t_http_0) * 1000.0
    e2e_ms = (t_http_1 - t_start) * 1000.0

    res = json.loads(resp_bytes.decode("utf-8"))
    timings = res.get("timings", {})
    reg_ms = timings.get("transport_register_ms", 0.0)
    core_ocr_ms = timings.get("core_ocr_ms", 0.0)
    backend_total_ms = timings.get("backend_total_ms", 0.0)
    transport_overhead_ms = max(0.0, http_total_ms - backend_total_ms)

    return {
        "channel": "binary_multipart",
        "source_id": res.get("source_id", ""),
        "wire_bytes": wire_bytes,
        "wire_mb": wire_bytes / (1024.0 * 1024.0),
        "client_encode_ms": client_encode_ms,
        "transport_wire_ms": transport_overhead_ms,
        "server_ingest_ms": reg_ms,
        "core_ocr_ms": core_ocr_ms,
        "backend_total_ms": backend_total_ms,
        "e2e_ms": e2e_ms,
        "char_count": len(res.get("text", ""))
    }


def run_secondary_roi_operation(
    fixture_info: Dict[str, Any],
    source_id: str,
    roi_rect: Dict[str, Any]
) -> Tuple[Dict[str, float], Dict[str, float]]:
    """
    동일 이미지에 대한 2차 재인식 (ROI 크롭 영역 재인식):
    - Legacy Base64: 캔버스 크롭 이미지를 다시 Base64로 인코딩하여 전체 페이로드 재전송
    - Source Registry: source_id 기반 재인식 (이미지 재전송 0 bytes, O(1) 인메모리 크롭)
    """
    raw_img = fixture_info["image"]
    # 1. Legacy Base64 재실행
    t_leg_start = time.perf_counter()
    crop_img = raw_img.crop((
        roi_rect["x"],
        roi_rect["y"],
        roi_rect["x"] + roi_rect["width"],
        roi_rect["y"] + roi_rect["height"]
    ))
    buf = io.BytesIO()
    crop_img.save(buf, format="PNG")
    crop_bytes = buf.getvalue()
    b64_crop = base64.b64encode(crop_bytes).decode("ascii")
    crop_data_url = f"data:image/png;base64,{b64_crop}"
    t_leg_enc = time.perf_counter()

    res_leg = recognize_ocr_base64(crop_data_url, lang="ko", save_history=False)
    t_leg_end = time.perf_counter()
    legacy_e2e_ms = (t_leg_end - t_leg_start) * 1000.0

    legacy_metrics = {
        "wire_mb": len(crop_data_url.encode("utf-8")) / (1024.0 * 1024.0),
        "client_encode_ms": (t_leg_enc - t_leg_start) * 1000.0,
        "core_ocr_ms": res_leg.get("timings", {}).get("core_ocr_ms", 0.0),
        "e2e_ms": legacy_e2e_ms
    }

    # 2. Source Registry 재실행 (source_id 0-재전송)
    t_src_start = time.perf_counter()
    res_src = recognize_ocr_source(source_id, roi=roi_rect, lang="ko", save_history=False)
    t_src_end = time.perf_counter()
    source_e2e_ms = (t_src_end - t_src_start) * 1000.0

    source_metrics = {
        "wire_mb": 0.0,  # 0바이트 전송
        "client_encode_ms": 0.0,
        "core_ocr_ms": res_src.get("timings", {}).get("core_ocr_ms", 0.0),
        "e2e_ms": source_e2e_ms
    }

    return legacy_metrics, source_metrics


# =============================================================================
# 4. 종합 벤치마크 실행 및 리포트 포매터
# =============================================================================
def benchmark_transport_pipeline(repeats: int = 5, export_json: Optional[str] = None):
    print("=" * 82)
    print(" 🚀 Util-Tools OCR Transport Layer Benchmark (5 Iterations Median)")
    print("=" * 82)
    print(f" * 반복 횟수: {repeats}회 (Warm Core Inference 후 Median 산출)")
    print(f" * 비교 채널: [1] Base64 WebSocket RPC (Legacy)")
    print(f"              [2] Native File Dialog (Source Registry Opaque Handle)")
    print(f"              [3] Local HTTP Binary Multipart Transport (Single Round-Trip)")
    print(f"              [4] Secondary ROI 0-Re-transmission")
    print("-" * 82)

    tmp_dir = _PROJECT_ROOT / "temp_transport_bench"
    fixtures = generate_benchmark_fixtures(tmp_dir)

    print(f" * 로컬 테스트 HTTP 서버 기동 중...")
    base_url, server_thread = start_test_server()
    print(f" * 로컬 HTTP 서버 활성화 완료: {base_url}")
    print("-" * 82)

    # 1. 워밍업 1회 (Windows OCR 엔진 및 캐시 예열)
    print(" [예열] Windows OCR 런타임 캐시 및 JIT 워밍업 실행 중...", end="", flush=True)
    warm_fix = fixtures[0]
    run_channel_base64_legacy(warm_fix["raw_bytes"])
    run_channel_native_handle(warm_fix["file_path"])
    run_channel_binary_multipart(base_url, warm_fix["raw_bytes"], "warmup.png")
    print(" 완료!\n")

    summary_results = []

    # 2. 각 Fixture별 5회 계측
    for fix_idx, fix in enumerate(fixtures, 1):
        print(f" ▶ Fixture {fix_idx}: {fix['name']}")
        print(f"   - 해상도: {fix['width']}x{fix['height']} | 원본 PNG 크기: {fix['raw_size_mb']:.2f} MB")

        b64_runs = []
        native_runs = []
        bin_runs = []
        last_source_id = ""

        for r in range(repeats):
            # 1) Base64 Legacy
            b64_res = run_channel_base64_legacy(fix["raw_bytes"])
            b64_runs.append(b64_res)

            # 2) Native Handle
            nat_res = run_channel_native_handle(fix["file_path"])
            native_runs.append(nat_res)

            # 3) Binary Multipart
            bin_res = run_channel_binary_multipart(base_url, fix["raw_bytes"], f"{fix['id']}.png")
            bin_runs.append(bin_res)
            last_source_id = bin_res.get("source_id", "")

        # Median 계산
        def calc_median(runs: List[Dict[str, Any]], key: str) -> float:
            vals = [x[key] for x in runs]
            return round(statistics.median(vals), 1)

        b64_med = {
            "channel": "Base64 WebSocket RPC",
            "wire_mb": calc_median(b64_runs, "wire_mb"),
            "inflation_pct": round(((calc_median(b64_runs, "wire_mb") - fix["raw_size_mb"]) / fix["raw_size_mb"]) * 100.0, 1),
            "client_encode_ms": calc_median(b64_runs, "client_encode_ms"),
            "transport_wire_ms": calc_median(b64_runs, "transport_wire_ms"),
            "server_ingest_ms": calc_median(b64_runs, "server_ingest_ms"),
            "core_ocr_ms": calc_median(b64_runs, "core_ocr_ms"),
            "e2e_ms": calc_median(b64_runs, "e2e_ms")
        }

        nat_med = {
            "channel": "Registered File Source",
            "wire_mb": 0.0,
            "inflation_pct": -100.0,
            "client_encode_ms": 0.0,
            "transport_wire_ms": 0.0,
            "server_ingest_ms": calc_median(native_runs, "server_ingest_ms"),
            "core_ocr_ms": calc_median(native_runs, "core_ocr_ms"),
            "e2e_ms": calc_median(native_runs, "e2e_ms")
        }

        bin_med = {
            "channel": "Binary Multipart (HTTP)",
            "wire_mb": calc_median(bin_runs, "wire_mb"),
            "inflation_pct": round(((calc_median(bin_runs, "wire_mb") - fix["raw_size_mb"]) / fix["raw_size_mb"]) * 100.0, 1),
            "client_encode_ms": 0.0,
            "transport_wire_ms": calc_median(bin_runs, "transport_wire_ms"),
            "server_ingest_ms": calc_median(bin_runs, "server_ingest_ms"),
            "core_ocr_ms": calc_median(bin_runs, "core_ocr_ms"),
            "e2e_ms": calc_median(bin_runs, "e2e_ms")
        }

        # 4) Secondary Operation (ROI 30% 영역 재인식 5회 계측)
        roi_rect = {
            "x": int(fix["width"] * 0.1),
            "y": int(fix["height"] * 0.1),
            "width": int(fix["width"] * 0.6),
            "height": int(fix["height"] * 0.3)
        }
        sec_leg_runs = []
        sec_src_runs = []
        for _ in range(repeats):
            l_met, s_met = run_secondary_roi_operation(fix, last_source_id, roi_rect)
            sec_leg_runs.append(l_met)
            sec_src_runs.append(s_met)

        sec_leg_med = {
            "wire_mb": round(statistics.median([x["wire_mb"] for x in sec_leg_runs]), 2),
            "e2e_ms": round(statistics.median([x["e2e_ms"] for x in sec_leg_runs]), 1)
        }
        sec_src_med = {
            "wire_mb": 0.0,
            "e2e_ms": round(statistics.median([x["e2e_ms"] for x in sec_src_runs]), 1)
        }

        summary_results.append({
            "fixture": fix["name"],
            "raw_size_mb": fix["raw_size_mb"],
            "b64": b64_med,
            "native": nat_med,
            "binary": bin_med,
            "secondary_legacy": sec_leg_med,
            "secondary_source": sec_src_med
        })

        # 터미널 포맷 출력
        print(f"   ┌───────────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐")
        print(f"   │ 전송 방식 (Transport)     │ 전송용량(MB) │ 클라이언트(ms)│ 전송/파싱(ms)│ OCR 코어(ms) │ E2E 지연(ms) │")
        print(f"   ├───────────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤")
        print(f"   │ [Legacy] Base64 WebSocket │ {b64_med['wire_mb']:>9.2f} MB │ {b64_med['client_encode_ms']:>10.1f} ms │ {b64_med['transport_wire_ms']+b64_med['server_ingest_ms']:>10.1f} ms │ {b64_med['core_ocr_ms']:>10.1f} ms │ {b64_med['e2e_ms']:>10.1f} ms │")
        print(f"   │ [신규] Registered File    │ {nat_med['wire_mb']:>9.2f} MB │ {nat_med['client_encode_ms']:>10.1f} ms │ {nat_med['server_ingest_ms']:>10.1f} ms │ {nat_med['core_ocr_ms']:>10.1f} ms │ {nat_med['e2e_ms']:>10.1f} ms │")
        print(f"   │ [신규] Binary Multipart   │ {bin_med['wire_mb']:>9.2f} MB │ {bin_med['client_encode_ms']:>10.1f} ms │ {bin_med['transport_wire_ms']+bin_med['server_ingest_ms']:>10.1f} ms │ {bin_med['core_ocr_ms']:>10.1f} ms │ {bin_med['e2e_ms']:>10.1f} ms │")
        print(f"   └───────────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘")
        print(f"   ⚡ E2E 속도 개선율 (대비 Base64):")
        print(f"      - Registered File Source : {b64_med['e2e_ms']:.1f}ms ➔ {nat_med['e2e_ms']:.1f}ms (Δ -{b64_med['e2e_ms'] - nat_med['e2e_ms']:.1f}ms, {b64_med['e2e_ms'] / max(1.0, nat_med['e2e_ms']):.2f}x 고속)")
        print(f"      - Binary HTTP            : {b64_med['e2e_ms']:.1f}ms ➔ {bin_med['e2e_ms']:.1f}ms (Δ -{b64_med['e2e_ms'] - bin_med['e2e_ms']:.1f}ms, {b64_med['e2e_ms'] / max(1.0, bin_med['e2e_ms']):.2f}x 고속)")
        print(f"   🔄 ROI 영역 재인식 (Secondary Crop Re-recognition):")
        print(f"      - [Legacy] Base64 재인코딩/재전송 : {sec_leg_med['wire_mb']:.2f} MB 전송 | E2E {sec_leg_med['e2e_ms']:.1f} ms")
        print(f"      - [신규] Source Registry (0-byte payload) : {sec_src_med['wire_mb']:.2f} MB 이미지 전송 | E2E {sec_src_med['e2e_ms']:.1f} ms (Δ -{sec_leg_med['e2e_ms'] - sec_src_med['e2e_ms']:.1f}ms)")
        print()

    # 3. 임시 파일 정리
    try:
        for f in tmp_dir.glob("*"):
            f.unlink()
        tmp_dir.rmdir()
    except Exception:
        pass

    # 4. JSON 파일 저장
    if export_json:
        with open(export_json, "w", encoding="utf-8") as f:
            json.dump(summary_results, f, indent=2, ensure_ascii=False)
        print(f" [INFO] 벤치마크 결과가 JSON으로 저장되었습니다: {export_json}")

    print("=" * 82)
    print(" ✅ 전송 계층 벤치마크 측정 완료")
    print("=" * 82)
    return summary_results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Util-Tools OCR 전송 계층 성능 벤치마크")
    parser.add_argument("--repeats", type=int, default=5, help="케이스당 반복 횟수 (기본 5회)")
    parser.add_argument("--export-json", type=str, default="", help="결과를 저장할 JSON 파일 경로")
    args = parser.parse_args()

    benchmark_transport_pipeline(repeats=args.repeats, export_json=args.export_json or None)
