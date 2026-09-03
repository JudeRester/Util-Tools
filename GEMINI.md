# 🛠️ Util-Tools Workspace Guidelines & Code Integrity Rules

본 프로젝트는 Python Eel, SQLite 중앙 DB, 로컬 AI 딥러닝 검색 엔진 기반의 모던 데스크톱 유틸리티 애플리케이션입니다.

## 🚨 필수 개발 및 변경 규정 (Mandatory Guidelines)

1. **경로 참조 원칙**:
   - 모든 파일/디렉토리 경로는 [`core.paths`](file:///D:/python/core/paths.py)에 정의된 표준 상수(`APP_DIR`, `BUNDLE_DIR`, `DATA_DIR`, `WEB_DIR`, `ICON_PATH`, `DB_PATH`, `EMAILS_DIR`, `MODELS_DIR`, `TEMPLATES_DIR`)를 사용해야 합니다.
   - 개별 모듈에서 `base_dir`을 임의로 선언하거나 하드코딩하는 것을 엄격히 금지합니다.

2. **전역 변수 / 함수 변경 시 영향도 전수 조사**:
   - 전역 변수, 상수, 함수 파라미터가 수정되면 `main.py`, `run.pyw`, `core/*.py`, `services/*.py`, `web/js/*.js`, `web/style.css` 전체에서 해당 참조를 검색하여 누락 없이 일괄 갱신합니다.

3. **작업 완료 처리 전 수정한 파일 목록화 및 Syntax Check 의무 실행**:
   - **① 수정 파일 목록화**: 작업 완료 보고 전 반드시 `git status --short`로 변경된 파일 목록을 확인하고 기록합니다.
   - **② 파일 유형별 구문 검사 (Syntax Check)**:
     - `*.py / *.pyw`: `python -m py_compile <수정된 파이썬 파일들>`
     - `*.js`: `node -c <수정된 JS 파일들>`
     - `*.css`: 중괄호 짝 일치(`{` == `}`) 및 파싱 검사 `python -c "import re; t=open('web/style.css', encoding='utf-8').read(); c=re.sub(r'/\*.*?\*/','',t,flags=re.DOTALL); assert c.count('{')==c.count('}'), 'CSS brace mismatch!'"`
     - `*.json`: `python -c "import json; json.load(open('<수정된 JSON>', encoding='utf-8'))"`
   - **③ 진입점 무결성 검증**: `python -c "from core.paths import BUNDLE_DIR; from core.tray import TrayManager; tm = TrayManager(BUNDLE_DIR); assert tm.get_tray_image() is not None"`
   - **④ 백엔드 서비스 레이어 & SQLite DB 검증**: `python -c "import services.db_service as d, services.redmine_service, services.email_service, services.ai_search_service; d.init_db()"`
   - **⑤ 프론트엔드 JS 전체 문법 검증**: `node -c web/js/*.js`

4. **자세한 규정 참조**:
   - [`.agents/rules/code_integrity.md`](file:///D:/python/.agents/rules/code_integrity.md)

