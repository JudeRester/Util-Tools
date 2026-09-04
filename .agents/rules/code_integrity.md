---
name: code-integrity-and-impact-analysis
description: 전역 변수, 경로 참조, 클래스/함수 변경 시 영향도 분석 및 무결성 검증 규정
trigger: always_on
---

# 🛡️ 코드 무결성 및 전역 영향도 검사 규정 (Code Integrity & Impact Analysis Rule)

본 프로젝트(Util-Tools)에서 코드 리팩토링, 기능 추가 또는 수정 작업을 진행할 때는 반드시 아래의 **전역 변수/경로 무결성 및 영향도 검사 절차**를 준수해야 합니다.

---

## 1. 전역 변수 및 경로 참조 표준화 원칙

1. **중앙 경로 관리자(`core.paths`) 필수 사용**:
   - 모든 파일 경로(정적 자산 `web/`, AI 모델 `models/`, SQLite DB `data/app.db`, 이메일 `emails/`, 설정 파일 등)는 반드시 [`core.paths`](file:///D:/python/core/paths.py)의 상수를 통해 참조해야 합니다.
   - 개별 모듈에서 `base_dir`, `os.path.dirname(__file__)` 등을 임의로 선언하여 사용하는 것을 엄격히 금지합니다.
2. **모듈 임포트 및 의존성 격리**:
   - 신규 전역 변수나 상수를 도입할 때는 기존 전역 네임스페이스와 충돌하지 않도록 모듈 단위 캡슐화를 유지합니다.

---

## 2. 변경 시 영향도 검사 (Impact Analysis) 의무화

다음과 같은 변경이 발생한 경우, 연관된 모든 영역에 대해 **영향도 전수 조사**를 실행해야 합니다:

1. **전역 변수 / 상수 / 경로 수정 시**:
   - 해당 변수나 상수를 참조하던 모든 호출처(`main.py`, `run.pyw`, `core/*.py`, `services/*.py`)를 `grep_search`로 전수 검색하여 누락 없이 교체되었는지 확인합니다.
2. **진입점(`main.py`, `run.pyw`) 및 코어(`core/tray.py`) 수정 시**:
   - 트레이 관리자(`TrayManager`) 생성자 인자 및 Eel 초기화 파라미터가 올바르게 전달되는지 반드시 검증합니다.
3. **서비스 레이어(`services/*.py`) API 수정 시**:
   - `@eel.expose` 함수 시그니처 변경 시 프론트엔드(`web/js/*.js`) 호출부와 일치하는지 확인합니다.
   - 백업 레지스트리([`services/backup_service.py`](file:///D:/python/services/backup_service.py)), AI 검색([`services/ai_search_service.py`](file:///D:/python/services/ai_search_service.py)), 패키징 정의서([`UtilTools.spec`](file:///D:/python/UtilTools.spec))에 누락 없이 등록되었는지 검사합니다.

---

## 3. 작업 완료 전 필수 검증 및 Syntax Check 파이프라인

사용자에게 작업 완료를 보고하기 전, 반드시 아래의 **수정 파일 목록화 및 전수 Syntax Check 파이프라인**을 모두 실행하고 통과해야 합니다:

### 0단계: 수정한 파일 전수 목록화 (Modified Files Listing)
```powershell
# 변경된 파일 목록 확인 및 보고서 준비
git status --short
```

### 1단계: 통합 원스톱 무결성 검증 (권장 표준)
동적 파일 탐색(Dynamic Discovery) 및 서비스 인트로스펙션 기반으로 파일 추가 시에도 수정 없이 전수 검증을 수행합니다:
```powershell
python scripts/verify_integrity.py
```
- **1단계: Python 전수 컴파일** (`py_compile`) - 모든 `.py`, `.pyw` 파일 동적 발견 및 바이트코드 검증
- **2단계: 백엔드 서비스 인트로스펙션 & SQLite DB** - `services/*.py` 전수 동적 임포트 및 `db_service.init_db()` 검증
- **3단계: 프론트엔드 JavaScript 문법 검사** - `web/js/*.js` 전수 `node -c` 검증
- **4단계: 스타일시트 구조 검사** - `web/style.css` 중괄호 짝 일치 검증
- **5단계: 코어 진입점 및 시스템 트레이** - `TrayManager(BUNDLE_DIR).get_tray_image()` 검증

### 2단계: 개별 및 부분 검증 파이프라인 (필요 시 선택 실행)
특정 레이어만 빠르게 확인해야 하는 경우 CLI 옵션 또는 개별 명령어를 사용합니다:
```powershell
# [특정 단계만 검증 시]
python scripts/verify_integrity.py --step 1   # Python 구문만
python scripts/verify_integrity.py --step 2   # 백엔드 서비스 & DB만
python scripts/verify_integrity.py --step 3   # 프론트엔드 JS만

# [JSON 파일 형식 검증]
python -c "import json; json.load(open('<수정된_JSON_파일>', encoding='utf-8')); print('JSON Syntax OK')"
```

---

## 4. 직관적·기술적 용어 사용 및 과장 표현 지양 원칙 (Objective Technical Phrasing)

코드베이스, 주석, 기술 문서, 기획서, Git 커밋 메시지 및 사용자 커뮤니케이션 작성 시 아래의 **직관적 기술 용어 표준화 원칙**을 엄격히 준수합니다:

1. **마케팅 버즈워드 배제**:
   - `원클릭`, `마법 같은`, `혁신적인` 등 실제 동작 과정을 모호하게 만들거나 상업적인 느낌을 주는 미사여구를 일체 배제합니다.
2. **주관적·과장된 수식어 금지**:
   - `초고속`, `빛의 속도로`, `극강의`, `완벽한`, `압도적인` 등 실측 근거 없는 과장된 표현의 사용을 엄격히 금지합니다.
3. **엔지니어링 팩트 및 정량 지표 기반 기술**:
   - 미사여구 대신 실제 동작 원리, 프로토콜, 정량적 수치로 담백하게 서술합니다.
   - 예시:
     - ❌ `0.005초 초고속 세션 락 감지` ➔ ⭕ `5ms 이내 논블로킹 세션 락 감지`
     - ❌ `원클릭 터미널 실행` ➔ ⭕ `터미널 세션 직접 실행`
     - ❌ `완벽한 싱글턴 보장` ➔ ⭕ `Windows 명명된 세마포어 기반 단일 인스턴스 보장`

---

## 5. 비차단 인레이어 UI 원칙 (Non-blocking In-layer UI Mandate)

프론트엔드 자바스크립트 코드 작성 시 아래의 **비차단 인레이어 UI 원칙**을 엄격히 준수합니다:

1. **블로킹 네이티브 다이얼로그 전면 금지**:
   - `alert()`, `confirm()`, `prompt()` 등 브라우저의 이벤트 루프 및 자바스크립트 실행 스레드를 블로킹(동기 중단)하는 브라우저 네이티브 팝업의 사용을 **전면 금지**합니다.
2. **비동기 인레이어 모달 표준 사용**:
   - 확인(`confirm` 대체): `await showAppConfirm(message, options)`
   - 입력(`prompt` 대체): `await showAppPrompt(message, defaultValue, options)`
   - 단순 알림(`alert` 대체): `await showAppAlert(message, title, icon)` 또는 `showToast(title, message, icon)`
3. **Promise 기반 비동기 흐름 제어**:
   - 모든 사용자 입력 확인 로직은 `async/await` 비동기 흐름으로 처리하여 UI 렌더링 지연 및 이벤트 루프 중단을 완벽히 방지합니다.



