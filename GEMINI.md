# 🛠️ Util-Tools Workspace Guidelines & Code Integrity Rules

본 프로젝트는 Python Eel, SQLite 중앙 DB, 로컬 AI 딥러닝 검색 엔진 기반의 모던 데스크톱 유틸리티 애플리케이션입니다.

## 🚨 필수 개발 및 변경 규정 (Mandatory Guidelines)

1. **GitFlow 브랜치 전략 및 main 브랜치 보호 규정 (GitFlow & Protected main Branch)**:
   - **`main` 브랜치 직접 변경 전면 금지**: `main` 브랜치에서 직접적인 파일 수정, 코드 편집, 커밋(`git commit`), 푸시(`git push`)를 엄격히 금지합니다.
   - **작업 브랜치 생성 및 전환 의무화**: 모든 기능 개발, 버그 수정, 리팩토링은 작업 착수 전 목적에 맞는 브랜치(`feature/*`, `bugfix/*`, `hotfix/*`, `release/*`)를 생성하고 해당 브랜치로 전환(`git switch -c` / `git checkout -b`)한 뒤 작업해야 합니다.
   - **작업 전 현재 브랜치 확인**: 코드 수정 전 반드시 `git branch --show-current`를 확인하여 현재 브랜치가 `main`이 아님을 검증합니다.
   - **GitFlow 브랜치 체계 및 역할**:
     * `main`: 상시 배포 가능한 프로덕션 브랜치 (직접 커밋 금지, 릴리스/핫픽스 병합만 허용)
     * `develop`: 차기 출시를 위한 개발 통합 중심 브랜치
     * `feature/<기능명>`: `develop`에서 분기 ➔ 기능 개발 ➔ `develop`으로 병합
     * `bugfix/<결함명>`: `develop`에서 분기 ➔ 개발 결함 조치 ➔ `develop`으로 병합
     * `release/v<x.y.z>`: `develop`에서 분기 ➔ 릴리스 준비 및 검수 ➔ `main` 및 `develop`으로 병합
     * `hotfix/v<x.y.z+1>`: `main`에서 분기 ➔ 운영 긴급 결함 조치 ➔ `main` 및 `develop`으로 병합

2. **경로 참조 원칙**:
   - 모든 파일/디렉토리 경로는 [`core.paths`](file:///F:/D_Tool/Util/Util-Tools/core/paths.py)에 정의된 표준 상수(`APP_DIR`, `BUNDLE_DIR`, `DATA_DIR`, `WEB_DIR`, `ICON_PATH`, `DB_PATH`, `EMAILS_DIR`, `MODELS_DIR`, `TEMPLATES_DIR`)를 사용해야 합니다.
   - 개별 모듈에서 `base_dir`을 임의로 선언하거나 하드코딩하는 것을 엄격히 금지합니다.

3. **전역 변수 / 함수 변경 시 영향도 전수 조사**:
   - 전역 변수, 상수, 함수 파라미터가 수정되면 `main.py`, `run.pyw`, `core/*.py`, `services/*.py`, `web/js/*.js`, `web/style.css` 전체에서 해당 참조를 검색하여 누락 없이 일괄 갱신합니다.

4. **작업 완료 처리 전 수정한 파일 목록화 및 Syntax Check 의무 실행**:
   - **① 수정 파일 목록화**: 작업 완료 보고 전 반드시 `git status --short`로 변경된 파일 목록을 확인하고 기록합니다.
   - **② 통합 원스톱 무결성 검증 (권장)**:
     - `python scripts/verify_integrity.py`
     - 동적 탐색(Dynamic Discovery) 기반으로 Python 전수 컴파일, 백엔드 서비스 전수 임포트 & SQLite DB 검증, 프론트엔드 JS 전수 문법 검사(`node -c`), CSS 괄호 검사, 트레이 아이콘 검증을 3초 이내에 자동 일괄 수행합니다. (파일이 추가되어도 스크립트 수정 불필요)
   - **③ 개별 수동 검증 파이프라인 (필요 시)**:
     - `*.py / *.pyw`: `python -m py_compile <수정된 파이썬 파일들>`
     - `*.js`: `node -c <수정된 JS 파일들>`
     - `*.css`: 중괄호 짝 일치(`{` == `}`) 검사
     - `*.json`: `python -c "import json; json.load(open('<수정된 JSON>', encoding='utf-8'))"`
   - **④ 매 작업 단위 완료 즉시 단위 커밋(Atomic Commit) 의무 실행**:
     - 기능 추가, 결함 조치, 리팩토링 등 **모든 작업 단위가 완료되고 무결성 검증을 통과한 직후, 코드를 미커밋(Uncommitted/Dirty) 상태로 방치하지 않고 즉시 규격 커밋(`git commit`)을 수행**합니다.
     - 여러 작업이나 수정을 하나의 커밋으로 몰아서 처리하는 배치 커밋을 엄격히 금지하며, 작업 단위별 독립 커밋을 보장합니다.
     - Conventional Commits 규격 준수 (`feat:`, `fix:`, `refactor:`, `docs:`, `test:` 등) 및 이슈 번호 연동 (`(#이슈번호)`).

5. **직관적·기술적 용어 사용 및 과장 표현 지양 원칙 (Objective Technical Phrasing)**:
   - 코드, 주석, 문서(README, Docs), 커밋 메시지, 기획서 및 사용자 보고 시 **과장되거나 모호한 마케팅성 수식어 사용을 엄격히 금지**합니다.
   - **금지/지양 표현**:
     - `원클릭`, `마법 같은`, `혁신적인` 등 실제 동작 메커니즘을 모호하게 만드는 마케팅 버즈워드
     - `초고속`, `빛의 속도로`, `극강의`, `완벽한`, `압도적인` 등 주관적·과장된 미사여구
   - **표준 표현 원칙**:
     - 시스템의 실제 엔지니어링 동작, 프로토콜, 정량적 수치(예: "5ms 파일 락 검사", "인라인 즉시 갱신", "터미널 직접 실행")를 사실에 기반하여 직관적이고 담백하게 기술합니다.

6. **비차단 인레이어 UI 원칙 (Non-blocking In-layer UI Mandate)**:
   - 브라우저 자바스크립트 실행 흐름 및 렌더링을 차단(block)하는 브라우저 네이티브 대화상자(`alert()`, `confirm()`, `prompt()`)의 사용을 **전면 금지**합니다.
   - 사용자 입력, 확인, 단순 알림이 필요한 모든 상호작용은 비동기 Promise 기반의 **인레이어 모달 팝업(`showAppAlert()`, `showAppConfirm()`, `showAppPrompt()`) 또는 실시간 토스트(`showToast()`)**만을 사용해야 합니다.

7. **자세한 규정 참조**:
   - [`.agents/rules/git_flow.md`](file:///F:/D_Tool/Util/Util-Tools/.agents/rules/git_flow.md) : GitFlow 브랜치 전략 및 main 브랜치 보호 규정
   - [`.agents/rules/code_integrity.md`](file:///F:/D_Tool/Util/Util-Tools/.agents/rules/code_integrity.md) : 코드 무결성 및 영향도 검사 규정


