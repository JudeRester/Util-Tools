---
name: verify-integrity
description: >-
  Util-Tools 프로젝트의 전체 코드 무결성 및 구문 검증(Syntax Check)을 단일 명령어로 일괄 수행합니다.
  Python 컴파일, 백엔드 서비스 동적 임포트, SQLite DB 초기화, JavaScript 문법, CSS 괄호 일치, 트레이 아이콘 검증을 3초 이내에 완료합니다.
---

# 🛠️ Util-Tools 무결성 검증 스킬 (Verify Integrity)

## 개요
본 스킬은 `scripts/verify_integrity.py`를 호출하여 Util-Tools 프로젝트 전체의 구문 분석 및 회귀 검증을 자동으로 수행합니다.
**동적 파일 탐색(Dynamic Discovery)** 아키텍처를 채택하여 Python/JS 파일이 추가되거나 이름이 변경되더라도 검증 스크립트나 명령어를 수정할 필요 없이 100% 자동 동작합니다.

## 실행 방법
```powershell
python scripts/verify_integrity.py
```

### 선택 옵션 (CLI Flags)
- `python scripts/verify_integrity.py -v`: 검증 중인 모든 파일 경로를 상세 출력
- `python scripts/verify_integrity.py --step 1`: 1단계(Python 전수 컴파일)만 개별 실행
- `python scripts/verify_integrity.py --step 2`: 2단계(백엔드 서비스 인트로스펙션 & SQLite DB)만 실행
- `python scripts/verify_integrity.py --step 3`: 3단계(프론트엔드 JS 문법 검사)만 실행
- `python scripts/verify_integrity.py --step 4`: 4단계(CSS 괄호 일치 검사)만 실행
- `python scripts/verify_integrity.py --step 5`: 5단계(트레이 아이콘 및 코어 진입점)만 실행

## 5단계 검증 파이프라인
1. **Python Dynamic Syntax Check**: `.git`, `venv`, `data` 등을 제외한 전수 `.py`, `.pyw` 파일의 바이트코드 컴파일 검증 (`py_compile`)
2. **Backend Services Introspection & SQLite DB**: `services/` 내 모든 모듈을 실시간으로 동적 임포트하여 상단 구문 오류, 순환 참조 검증 및 `db_service.init_db()` 검증
3. **Frontend JavaScript Syntax**: `web/js/` 내 모든 모듈의 Node.js 구문 분석 검증 (`node -c`)
4. **Stylesheet Structure & Braces**: `web/style.css` 중괄호(`{`, `}`) 짝 검증
5. **Core Entrypoint & System Tray**: `TrayManager(BUNDLE_DIR)` 인스턴스화 및 트레이 아이콘 유효성 검증
