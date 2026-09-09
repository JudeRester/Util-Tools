# 🔍 OCR Engine Architecture & Benchmark Decision Record (ADR)

본 문서는 Util-Tools 프로젝트의 광학 문자 인식(OCR) 엔진 선정, 전처리 파이프라인 설계 및 벤치마크 평가 결과에 대한 아키텍처 결정 기록(Architecture Decision Record)입니다.

---

## 1. 아키텍처 결정 요약 (Executive Summary)

* **최종 채택 엔진**: `Windows.Media.Ocr` (Windows 10/11 빌트인 OS Native 엔진)
* **전처리 파이프라인**: **Adaptive Lanczos Resampling** (최대 $2.5\text{M px}$ Upscaling Pixel Budget 한도)
* **대안 엔진 평가 결과**: `RapidOCR (PP-OCRv4 / PP-OCRv5 Korean Mobile ONNX)` 검토 후 **도입 보류/기각(Rejected)**
  - *결정 근거*: 현재 Util-Tools 환경, 기본 RapidOCR 파라미터 및 10개 대표 시나리오 corpus 조건에서 Windows Native OCR 대비 품질 개선 실익이 확인되지 않았으며, 추론 지연시간(15~20배 이상 느림) 및 프로세스 Working Set 증가(+260~280MB) 비용이 큼.
  - *판단 범위 한정*: 본 결정은 Util-Tools의 데스크톱 경량 유틸리티 요구사항 및 현재 테스트 조건에 한정되며, RapidOCR 모델 자체의 보편적 한계로 일반화하지 않습니다.
* **차기 최적화 로드맵**: OCR 모델 추가 대신 **프론트엔드-백엔드 간 DataURL Base64 RPC 전송 병목 최적화**(파일 경로 직접 전달, 로컬 바이너리 스트리밍)로 전환.

---

## 2. 엔진별 벤치마크 평가 결과 (10개 시나리오 실측)

*(측정 도구: `scripts/benchmark_rapidocr_comparison.py`, 케이스당 3회 반복 측정, 총 180회 추론 계측)*  
*(측정 대상: 8개 대표 시나리오 + 2개 실제 실패 사례 모사 합성 자막 Fixture, 총 10개 시나리오)*

### [표 1] 품질 및 지연시간 종합 비교표

| 파이프라인 | Whitespace Macro CER (정합률) | Whitespace Micro CER (정합률) | 라인 정합률 (보조지표) | Warm Core Median 지연 |
| :--- | :---: | :---: | :---: | :---: |
| **Windows OCR (Adaptive Lanczos)** | **0.056 (94.4%)** | **0.054 (94.6%)** | **100.0%** | **84.7 ms** |
| **Windows OCR (1x Raw 원본)** | 0.118 (88.2%) | 0.135 (86.5%) | 96.7% | 73.0 ms |
| **RapidOCR v4 (1x Raw 원본)** | 0.284 (71.6%) | 0.223 (77.7%) | 73.3% | 1,953.5 ms |
| **RapidOCR v4 (Adaptive Lanczos)** | 0.397 (60.3%) | 0.351 (64.9%) | 65.0% | 1,990.8 ms |
| **RapidOCR v5 (1x Raw 원본)** | 0.263 (73.7%) | 0.176 (82.4%) | 55.0% | 1,347.6 ms |
| **RapidOCR v5 (Adaptive Lanczos)** | 0.264 (73.6%) | 0.167 (83.3%) | 55.0% | 1,399.1 ms |

> **메트릭 정의 및 방법론적 유의사항**:
> 1. **Whitespace-normalized Macro CER**: 각 시나리오 케이스별 공백 정규화 CER의 산술평균입니다.
> 2. **Whitespace-normalized Micro CER**: 전체 케이스의 $\frac{\sum \text{편집거리}}{\sum \text{정답문자수}}$로 계산하여 문자열 길이 가중치를 정량 반영한 지표입니다.
> 3. **라인 정합률 (Line Match Recall)**: 정답 라인 중 추출된 텍스트와 50% 이상 편집 유사도를 갖는 라인의 비율입니다. 엔진별 텍스트 박스 병합/분할 기준 차이가 개입되므로 순수 bbox 검출률이 아닌 **보조지표**로 취급합니다.
> 4. **지연시간 통계 (Median)**: 케이스당 3회 반복 측정 후 케이스별 Median 지연시간에 대한 평균값입니다. (반복 표본 수가 3회이므로 통계적 왜곡을 방지하기 위해 P95는 공식 지표에서 배제하고 중앙값(Median)만을 공식 지표로 채택합니다.)

---

### [표 2] 엔진 도입 비용 및 시스템 리소스 비교표

| 엔진명 | Engine Init + First Inference | Warm Core Median 지연 | 격리 증분 Working Set (Delta Peak WS) | 모델 파일 용량 | 패키징 예상 증가 (Estimated) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Windows.Media.Ocr** | **22.8 ms** | **84.7 ms** | **+34.4 MB** | **0.0 MB (OS 내장)** | **0.0 MB (추가 없음)** |
| **RapidOCR PP-OCRv4** | 2,552.7 ms | 1,953.5 ms | +280.0 MB | 28.04 MB | +~60~70 MB (추정치) |
| **RapidOCR PP-OCRv5** | 1,058.4 ms | 1,347.6 ms | +265.7 MB | 18.02 MB | +~60~70 MB (추정치) |

> **실측 조건**:
> - **Engine Init + First Inference**: 엔진 인스턴스화(ONNX 세션 로딩/초기화) + 최초 1회 더미 추론 완료 시점까지의 실측 시간입니다. (파이썬 모듈 import 시간은 제외된 순수 엔진 런타임 셋업 시간입니다.)
> - **격리 증분 Working Set**: 각 엔진을 별도의 fresh subprocess로 격리 실행하여 $1511 \times 796$ 합성 자막 이미지 추론 시의 `Delta Peak Working Set (PeakWorkingSetSize - BaselineWorkingSetSize)`을 Windows API(`GetProcessMemoryInfo`)로 계측한 값입니다 (`scripts/benchmark_ocr_memory.py`).

---

## 3. 세부 관측 사실 및 기술적 분석

1. **전처리 효과 vs 엔진 고유 효과의 분리**:
   - `Windows.Media.Ocr`는 2.5M 버짓 한도 내의 적응형 Lanczos 업스케일 적용 시 Macro CER이 0.118 ➔ 0.056으로, Micro CER이 0.135 ➔ 0.054로 일관되게 개선(정합률 86.5% ➔ 94.6%, **+8.1%p**)되었습니다.
   - `RapidOCR v4`의 경우 외부 Lanczos 업스케일 적용 시 Macro CER이 0.284 ➔ 0.397로 변동했습니다. 다만 이는 외부 리사이징과 RapidOCR 내부의 자체 리사이징 정책(`limit_side_len` 등) 및 검출 임계값 간의 상호작용 가능성이 존재하는 혼재 변인(confounder)으로 해석합니다.
2. **합성 자막 시뮬레이션(Case 9, Case 10) 관측 사실 및 외적 타당성 한계**:
   - **관측 사실**: 사용자 실패 사례를 모사한 $1511 \times 796$ 어두운 배경 외곽선 자막 시뮬레이션 환경에서, RapidOCR 기본 detector 설정 시 2줄 중 1줄이 Line Match 기준(50% 유사도)을 충족하지 못했습니다 (Line Match Recall 50%). 반면 Windows Native OCR은 **두 정답 라인 모두 Line Match 조건을 충족(100%)**하였습니다.
   - **외적 타당성(External Validity)의 한계**: Case 9 및 Case 10은 실제 동영상 스크린샷 파일이 아니라, 사용자 환경에서 관측된 폰트, 크기, 외곽선, 배경 그라데이션을 코드로 모사한 '합성 시뮬레이션 Fixture'입니다. 따라서 본 테스트 결과가 복잡한 실제 동영상 캡처 환경 전체를 대변하기에는 표본의 한계가 있음을 명시합니다.
3. **지연시간 및 UX 적합성**:
   - 데스크톱 실시간 유틸리티 관점에서 사용자 인터랙션 지연은 100ms 안팎으로 억제되어야 합니다.
   - Windows OCR의 순수 코어 지연은 중앙값 기준 약 **85ms**로 즉각적인 처리가 가능하지만, RapidOCR v4는 CPU 환경에서 중앙값 기준 약 **1,950ms**, v5는 약 **1,350ms**가 소요되어 상시 유틸리티로서의 반응성에 적합하지 않습니다.

---

## 4. 최종 설계 결정 및 정책

1. **단일 엔진 체제 확정**:
   - Util-Tools의 상용 배포 패키지(`requirements.txt`, `UtilTools.spec`)에는 RapidOCR 관련 의존성을 추가하지 않으며, `Windows.Media.Ocr` 단일 엔진 파이프라인을 유지합니다.
   - 불필요한 바이너리 비대화(+60~70MB) 및 런타임 Working Set 증가(+260~280MB)를 원천 차단합니다.
2. **회귀 벤치마크 하네스 보존**:
   - `scripts/benchmark_rapidocr_comparison.py` 및 `scripts/benchmark_ocr_memory.py`는 향후 OCR 모델 재평가 및 회귀 테스트를 위해 보존합니다.
   - `rapidocr` 패키지가 미설치된 환경에서는 스크립트가 비정상 종료되지 않고 안내 메시지와 함께 Windows OCR 단독 테스트로 안전하게 폴백(Graceful Fallback)하도록 구현되었습니다.
3. **Transport 계층 최적화 완료 및 결정 기록**:
   - 프론트엔드-백엔드 간 대용량 이미지 전송 및 재인식 파이프라인을 개편하여 `OcrSourceRegistry` 기반 Opaque Handle 아키텍처를 구축 완료하였습니다 (상세 내용은 5절 참조).

---

## 5. Transport 계층 아키텍처 개편 및 실측 벤치마크 결정 기록

*(측정 도구: `scripts/benchmark_ocr_transport.py`, 3종 Fixture 대상 5회 반복 계측, Median 산출)*

### 5.1 아키텍처 설계 및 보안 방어 체계

1. **Opaque Handle 기반 Source Registry (`OcrSourceRegistry`)**:
   - 파일 시스템의 실제 절대 경로는 Python 백엔드 메모리에만 은닉하고 프론트엔드에는 UUID4 기반 `source_id`만 노출하여 Arbitrary Local File Read 취약점을 원천 차단합니다.
   - 최대 5개 소스에 대한 LRU 축출 및 30분 TTL 자동 정리 정책을 적용합니다.
2. **다층 방어 체계 (Loopback + Origin 검증 + Process Nonce)**:
   - `127.0.0.1` / `::1` 루프백 IP 바인딩 검증
   - `Host` 헤더 (`localhost`, `127.0.0.1`) 검증
   - `Sec-Fetch-Site` (`same-origin`, `none`, `same-site`) 브라우저 출처 검증
   - 프로세스 기동 시 발급되는 세션 토큰(`OCR_SESSION_TOKEN`, `X-UtilTools-Token` 헤더) 검증을 결합하여 로컬 웹페이지의 비인가 교차 출처 요청(Cross-Origin POST/DELETE)을 완화하는 다층 방어를 적용합니다. (단, 동일 origin 내 XSS 등의 위협 모델까지 포괄하는 것은 아님)
3. **입력 채널별 맞춤형 전송 분기**:
   - **로컬 파일 선택 (`Registered File Source`)**: 백엔드 파일 대화상자를 통해 경로를 직접 레지스트리에 등록하여 이미지 데이터의 네트워크 전송량을 **0바이트**로 처리합니다.
   - **클립보드 / 드래그 앤 드롭 (`Binary Multipart`)**: Base64 인코딩을 배제하고 브라우저 `FormData` ➔ `POST /api/ocr/source` 단일 왕복(Single Round-Trip)으로 인메모리 버퍼링(`MEMFILE_MAX=50MB`, `MAX_UPLOAD_BYTES=25MB`) 처리합니다.

---

### 5.2 전송 채널별 실측 성능 비교 및 분석

#### [표 3] 최초 OCR 인입 시 전송 방식별 실측 비교 (5회 반복 Median)

| Fixture 시나리오 | 전송 방식 | 전송 페이로드 | 페이로드 팽창률 | 클라이언트 인코딩 | 전송/파싱 지연 | OCR 코어 지연 | E2E 지연시간 | 속도 비교 (대비 Base64) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Fixture 1**<br>1511×796 자막 영상<br>(원천 PNG 2.38 MB) | **[Legacy] Base64 WebSocket** | 3.20 MB | +34.5% | 10.3 ms | 9.3 ms | 118.0 ms | **221.1 ms** | 기준 (1.00x) |
| | **[신규] Registered File Source** | **0.00 MB** | **-100.0%** | **0.0 ms** | 19.2 ms | 107.1 ms | **202.2 ms** | **1.09x (8.5% 개선)** |
| | **[신규] Binary Multipart** | 2.40 MB | +0.8% | **0.0 ms** | 20.9 ms | 112.3 ms | **226.9 ms** | 0.97x (2.6% 악화) |
| **Fixture 2**<br>1920×1080 데스크톱<br>(원천 PNG 3.81 MB) | **[Legacy] Base64 WebSocket** | 5.10 MB | +33.9% | 21.5 ms | 14.6 ms | 186.7 ms | **341.9 ms** | 기준 (1.00x) |
| | **[신규] Registered File Source** | **0.00 MB** | **-100.0%** | **0.0 ms** | 34.9 ms | 160.4 ms | **308.2 ms** | **1.11x (9.9% 개선)** |
| | **[신규] Binary Multipart** | 3.80 MB | -0.3% | **0.0 ms** | 35.2 ms | 203.1 ms | **373.5 ms** | 0.92x (9.2% 악화) |
| **Fixture 3**<br>1920×1080 스트레스<br>(원천 PNG 5.37 MB) | **[Legacy] Base64 WebSocket** | 7.20 MB | +34.1% | 23.7 ms | 20.3 ms | 304.5 ms | **469.0 ms** | 기준 (1.00x) |
| | **[신규] Registered File Source** | **0.00 MB** | **-100.0%** | **0.0 ms** | 26.3 ms | 294.5 ms | **412.2 ms** | **1.14x (12.1% 개선)** |
| | **[신규] Binary Multipart** | 5.40 MB | +0.6% | **0.0 ms** | 25.5 ms | 306.0 ms | **460.2 ms** | **1.02x (1.9% 개선)** |

#### [표 4] 동일 이미지 2차 ROI 재인식 시 실측 비교 (5회 반복 Median)

| Fixture 시나리오 | 2차 ROI 재인식 방식 | 전송 페이로드 크기 | E2E 지연시간 | 지연시간 절감량 (Δ) | 개선 효과 |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Fixture 1** (1511×796) | [Legacy] 캔버스 크롭 후 Base64 재전송 | 0.57 MB | 117.1 ms | 기준 | 전체 페이로드 재인코딩/재전송 |
| | **[신규] Source Registry (0-byte image payload)** | **0.00 MB** | **85.5 ms** | **-31.6 ms** | **27.0% 단축** (요청 메타데이터만 전송) |
| **Fixture 2** (1920×1080) | [Legacy] 캔버스 크롭 후 Base64 재전송 | 0.97 MB | 166.8 ms | 기준 | 전체 페이로드 재인코딩/재전송 |
| | **[신규] Source Registry (0-byte image payload)** | **0.00 MB** | **117.1 ms** | **-49.7 ms** | **29.8% 단축** (요청 메타데이터만 전송) |
| **Fixture 3** (1920×1080) | [Legacy] 캔버스 크롭 후 Base64 재전송 | 1.43 MB | 378.4 ms | 기준 | 전체 페이로드 재인코딩/재전송 |
| | **[신규] Source Registry (0-byte image payload)** | **0.00 MB** | **324.9 ms** | **-53.5 ms** | **14.1% 단축** (요청 메타데이터만 전송) |

---

### 5.3 기술적 사실 및 성능 해석 (Epistemic Findings)

1. **최초 OCR 지연시간 관측 및 용어 정정**:
   - 실측 결과 `Registered File Source`는 Base64 대비 최초 OCR E2E를 약 **8.5% ~ 12.1% (Δ 18.9ms ~ 56.8ms)** 일관되게 단축했습니다.
   - 반면 `Binary Multipart`는 최초 요청 지연시간 측면에서 Base64 WebSocket 대비 일관된 우위를 보이지 않았습니다 (0.92x ~ 1.02x).
   - 따라서 본 아키텍처 개편의 본질은 "Base64 전송 병목 제거로 인한 최초 OCR 가속"이 아니라, **"Base64 인코딩 및 페이로드 팽창(+34%) 제거, 입력 소스별 적절한 transport 확보"**로 명문화합니다.
   - 클립보드/드롭에서 Multipart 도입의 가치는 최초 요청 가속이 아니라, `DataURL → JSON RPC`라는 불필요한 직렬화 변환을 배제하고 Source Registry로의 등록을 가능하게 하는 표준 바이너리 수신 체계를 확보한 데 있습니다.

2. **기존 UI 관측 지연(~750ms)과의 괴리 분석**:
   - 이전 UI 프로파일링에서 약 750ms의 RPC 구간 지연이 관측되었으나, 독립 transport benchmark에서는 순수 Base64 전송/디코딩 비용이 훨씬 작게(9.3ms ~ 20.3ms) 측정되었습니다.
   - 따라서 **해당 750ms 지연 전체를 WebSocket 전송 자체의 비용으로 귀속하지 않습니다.**
   - 실제 원인은 Eel RPC 래퍼 오버헤드, Promise 스케줄링, JSON 직렬화/역직렬화, 프론트엔드 상태 갱신, 동기 이미지 디코드/렌더링 등 브라우저 및 Eel 런타임 상의 복합적 요인이었을 가능성이 높음을 확인했습니다.

3. **Source Registry의 실질적 핵심 가치 (Stateful Image Source Reuse)**:
   - 본 개편의 실질적 핵심 성과는 최초 요청 가속이 아닌 **"상태 기반 이미지 소스 재사용(Stateful Image Source Reuse)"**입니다.
   - ROI 부분 영역 재인식 시 매번 0.57MB ~ 1.43MB의 이미지를 캔버스에서 재추출하여 전송하던 오버헤드를 **O(1) Registry lookup 후 backend에서 직접 ROI crop을 수행**하도록 전환하여, **0-byte image payload retransmission (이미지 데이터 0바이트 재전송, 요청 메타데이터만 전송)**으로 E2E 지연시간을 **14.1% ~ 29.8% (31.6ms ~ 53.5ms)** 일관되게 절감했습니다.
   - 이는 향후 ROI 반복 조정, 90° 회전, 언어 변경, 전처리 모드 변경 재실행을 모두 이미지 payload 재전송 없이 처리할 수 있는 구조적 토대를 마련했습니다.

4. **추가 Transport 미세 최적화 종결 결정**:
   - 현재 E2E 지연시간에서 Windows OCR 코어 엔진 자체가 100~300ms로 대부분을 차지하며, 전송 방식 간의 차이는 수십 ms 수준에 불과합니다.
   - 따라서 Transport 계층의 추가적인 미세 성능 최적화는 실익이 낮으므로 공식 종결하며, 향후 작업은 실제 기능 UX, ROI/회전 조작성, 수명주기 관리, 히스토리 및 오류 처리 안정화에 집중합니다.

---

## 6. 기능 안정화 및 Release Candidate (RC) 검증 기록

### 6.1 검증 범위의 한계 및 경계 명시 (Verification Scope Boundary)
본 단계의 **Release Gate PASS** 판정은 `scripts/test_ocr_release_gate.py` 및 `scripts/verify_integrity.py`를 통해 기계적으로 입증된 **자동화 테스트 범위(Harness & Dynamic Discovery)에 한정**됩니다.
브라우저 환경에서의 실제 사용자 인터랙션 흐름(클립보드 키 입력, 브라우저 렌더러 반응성, PyInstaller 빌드 배포본의 C++ Native DLL 런타임 바인딩)은 **수동 Smoke Test** 항목으로 명확히 분리하여 최종 품질을 보증합니다.

### 6.2 입력 한계 하드닝 및 방어 체계의 분리 규정
이미지 입력 단계의 보호 메커니즘은 상이한 목적과 동작 방식을 가지므로 다음과 같이 분리 정의합니다:

1. **애플리케이션 입력 제한 (Application-Level Bounds)**:
   - **단일 파일 업로드 용량**: 최대 $25\text{MB}$ (`MAX_UPLOAD_BYTES`, 초과 시 HTTP 413 `PAYLOAD_TOO_LARGE`)
   - **단일 변 최대 해상도**: $10,000\text{px}$ (`MAX_IMAGE_DIMENSION`, 초과 시 HTTP 400 `INVALID_IMAGE`)
   - **최대 총 픽셀 수**: $30,000,000\text{px}$ ($30\text{M px}$, `MAX_TOTAL_PIXELS`, 초과 시 HTTP 400 `INVALID_IMAGE`)
   - **허용 이미지 형식**: `PNG`, `JPEG`, `JPG`, `WEBP`, `BMP`, `TIFF` (`ALLOWED_IMAGE_FORMATS`, 비허용 시 HTTP 415 `UNSUPPORTED_FORMAT`)
2. **Pillow Decompression-Bomb Protection (라이브러리 레벨 추가 방어선)**:
   - 압축 헤더 대비 실제 압축 해제 시 메모리를 과도하게 점유하는 거대 픽셀 악의적 압축 이미지에 대해 Pillow의 `DecompressionBombError` 및 `DecompressionBombWarning`을 포착하여 프로세스 중단 없이 HTTP 400 `INVALID_IMAGE` 에러로 안전하게 변환 처리.

### 6.3 핵심 안정화 내역 (Core Reliability Hardening)
1. **비동기 요청 경쟁 방지 (Stale Response Drop)**:
   - `ocrState.currentRequestId` 식별 번호를 통해 빠른 연속 소스 변경이나 탭 이탈 시 지연 도착한 구형 비동기 응답이 최신 캔버스 및 UI 상태를 덮어쓰지 않도록 원천 차단.
2. **In-flight 이미지 객체 격리**:
   - `OcrSource.get_image()` 호출 시 `img.copy()` 독립 사본을 반환하여, OCR 추론 진행 중 백그라운드 LRU/TTL 만료나 명시적 삭제가 발생해도 메모리 참조 오류가 발생하지 않음.
3. **기하학적 좌표 불변성**:
   - $0^\circ \to 90^\circ \to 180^\circ \to 270^\circ \to 360^\circ(0^\circ)$ 회전 사이클 복귀 시 원본 베이스라인과의 Bounding Box 오차 1.5px 이내 수렴 확인.
   - ROI 크롭 및 수동 회전 조합 시 Line Union 외접 직사각형 포함 관계(`line_min <= word_min`, `line_max >= word_max`) 엄밀성 보장.
4. **히스토리 및 썸네일 멱등성**:
   - 디스크 상의 썸네일 파일 누락/기삭제 상태에서도 `delete_ocr_history()`가 예외 없이 SQLite 레코드를 정상 삭제.
5. **UI 이벤트 리스너 누적 차단**:
   - `ocrState.isInitialized` 가드 및 탭 수명주기 훅(`teardownOcrStudio`, `resumeOcrStudio`)을 통한 paste 리스너 단일 등록 유지.

### 6.4 배포본 최종 Smoke Test 프로토콜
다음 8개 시나리오에 대해 패키징 배포본(`dist/UtilTools/UtilTools.exe`)을 포함한 최종 수동 확인을 거친 후 OCR 기능을 완료 처리합니다:
1. `Win + Shift + S → Ctrl+V → OCR → 단어 클릭 복사`
2. 이미지 파일 열기 → ROI → 90° 회전 → ROI 재인식
3. 서로 다른 이미지 6개 연속 열기 → 첫 source 만료 후 UX 확인
4. OCR 실행 직후 다른 이미지 붙여넣기 → 오래된 결과가 새 이미지에 나타나지 않는지 확인
5. OCR 실행 중 탭 이동 → 복귀 → 다시 붙여넣기
6. history 삭제 / 전체 삭제 후 thumbnail 디렉터리 상태 확인
7. 앱 재시작 후 OCR 탭 최초 진입 및 언어 선택 정상 여부
8. **PyInstaller 배포본 검증**: 클립보드 / multipart / preview 엔드포인트 / Windows OCR 언어팩 탐지가 패키징 환경에서도 동일하게 동작하는지 확인


