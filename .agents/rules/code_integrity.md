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

## 3. 작업 완료 전 3단계 필수 검증 파이프라인

사용자에게 작업 완료를 보고하기 전, 반드시 아래의 3단계 검증을 모두 통과해야 합니다:

```powershell
# [1단계] 진입점 및 코어 트레이 무결성 검증
python -c "from core.paths import BUNDLE_DIR; from core.tray import TrayManager; tm = TrayManager(BUNDLE_DIR); img = tm.get_tray_image(); assert img is not None; print('Entrypoint & TrayManager OK')"

# [2단계] 서비스 레이어 전수 회귀 테스트
$env:PYTHONIOENCODING="utf-8"; python -c "import services.db_service as d, services.ai_search_service as a, services.email_service as e, services.redmine_service as r, services.mock_data_service as m; d.init_db(); print('All Backend Services OK')"

# [3단계] 프론트엔드 전체 JavaScript 문법 검증
node -c web/js/*.js
```
