# 🛠️ Utility Toolkit (유틸리티 도구 모음)

Python **Eel**과 **HTML5/CSS/JavaScript** 기반의 모던 다크 테마 데스크톱 유틸리티 도구 모음입니다.  
중앙 **SQLite DB(`data/app.db`)** 기반 데이터 영속화와 **로컬 AI 시맨틱 검색 엔진(Multilingual-E5 ONNX)**, **통합 AI 코딩 세션 허브(Antigravity CLI & OpenCodex)**를 내장하고 있으며, 백그라운드 시스템 트레이에 상주하여 다양한 개발 및 업무 도구를 간편하게 실행할 수 있습니다.

---

## 🌟 주요 기능 (Key Features)

| 카테고리 | 주요 제공 기능 |
| :--- | :--- |
| **🤖 통합 AI 코딩 세션 허브<br>(Antigravity & OpenCodex)** | • **듀얼 AI 에이전트 세션 통합 대시보드**: Google Antigravity(`agy`) 및 OpenAI OpenCodex(`ocx`) 세션을 통합 수집하여 타임스탬프 순 일원화 관리<br>• **터미널 실행 및 윈도우 전면 전환**: Alt 키 시뮬레이션 기반의 활성 콘솔 창 즉각 포커스 및 신규 대화형 터미널 백그라운드 분기 실행<br>• **5ms 논블로킹 활성 락 검사**: `msvcrt.locking` 파일 락 검사로 현재 터미널 실행 중인 세션을 실시간 감지<br>• **실시간 Live Tail 인스펙터**: Rollout JSONL 및 Transcript 스트리밍으로 턴별 프롬프트, 도구 호출, 결과 인앱 실시간 확인<br>• **비차단 영구 삭제**: `showAppConfirm` 모달을 통한 비활성 세션 영구 삭제 및 활성 세션 삭제 방어<br>• **클라우드 대화 필터링**: `codex-dev.db`의 웹 ChatGPT 동기화 내역을 배제하고 로컬 작업 워크스페이스 세션만 선별 노출<br>• **스마트 알림 파이프라인**: 턴 완료(`DONE`) 및 권한 승인 대기(`BypassSandbox`) 발생 시 Windows 트레이 알림 + 토스트 + 차임벨 전송 |
| **💼 업무 & 협업<br>(Redmine·달력·이메일)** | • **🦊 Redmine**: 내 일감(Issues) 실시간 대시보드, 상태/진척도 인라인 즉시 변경, 프로젝트 위키(Wiki) 뷰어/에디터, 백그라운드 트레이 알림, 관심 프로젝트(⭐ 즐겨찾기) 우선 필터<br>• **📅 달력 & 일정**: Google Calendar 및 iCal(ICS) 실시간 구독, 다크 테마 월간 캘린더 & 오늘의 아젠다<br>• **📧 이메일 아카이브**: 3,100+건 EML 로컬 보관소, 대화별 스레드 묶기(Thread View), 시간순 아코디언 타임라인, 첨부파일 추출 |
| **📊 뷰어 / 다이어그램<br>(CSV·MD·Mermaid·슬라이서)** | • **📋 CSV / TSV 뷰어**: 인코딩/구분자 자동 감지, 전역 검색/정렬, Markdown/JSON/SQL/CSV 변환<br>• **📝 Markdown 뷰어**: GFM 실시간 에디터, GitHub Alerts 콜아웃, 태스크 체크박스 동기화, 목차(TOC)<br>• **📊 Mermaid 다이어그램**: 16종 프리셋 시각화, 마우스 휠 줌/팬, SVG/PNG 고해상도 이미지 내보내기<br>• **✂️ 이미지 슬라이서**: Pillow 기반 다중 절단선, 고정 px 간격, 균등 N등분, 여백 자동 감지 & ZIP/폴더 저장 |
| **🧠 AI 시맨틱 검색** | • **로컬 딥러닝 신경망(`intfloat/multilingual-e5-small` ONNX)** 기반 의미론적 문맥 검색<br>• 키워드가 정확히 일치하지 않아도 의미와 문맥으로 전체 데이터(이메일, 메모, 다이어그램 등)를 탐색<br>• 문장 간 유사도 정밀 비교 및 증분 벡터 캐싱 지원 |
| **🎲 모의 데이터 스튜디오** | • **3-Pass 복합 가상 데이터 생성기 & 엑셀(.xlsx) / CSV 내보내기 엔진**<br>• 순번(Sequence), 한국인 이름/이메일 영문 로마자 표기법 변환, 선택(Choice) 및 키-값(Key-Value) 연계 매핑<br>• 커스텀 컬럼 양식 생성, 수정, 삭제 및 SQLite 영구 동기화 |
| **⚡ 빠른 실행 & 바로가기** | • **📁 폴더 바로가기**: 프로젝트 작업 디렉토리 바로가기 카드 및 **원하는 폴더 위치에서 PowerShell / CMD 즉시 실행 바**<br>• **⚡ 프로그램 & 툴 빠른 실행**: 자주 쓰는 앱/실행 파일(`.exe`, `.bat`), **SSH 터미널 접속**, **웹 URL**, **PowerShell 명령** 바로 실행<br>• 각각 전용 **[⚙️ 편집]** 팝업을 통한 항목 추가, 인라인 수정(`✏️`), 삭제, 파일/폴더 선택 대화상자 및 드래그 앤 드롭 순서 변경 |
| **🔢 커스텀 생성기** | • 사용자가 직접 JavaScript 스크립트로 **새로운 생성기 추가/수정/순서 변경** 가능<br>• 기본 내장: 국세청 사업자번호, UUID v4, 16자리 난수 비밀번호, 한국인 가상 더미, 타임스탬프 등 |
| **🧪 JS 실행기** | • JSFiddle / RunJS 스타일의 **JavaScript 코드 샌드박스** (비동기 `async/await` 지원)<br>• `console.log/warn/error` 출력 캡처, 실행 시간 측정, `Ctrl + Enter` 실행, 코드 자동 영구 보존 |
| **📝 빠른 메모** | • **경량 스크래치패드 / 메모장**<br>• 다중 메모 생성, 실시간 자동 저장(Autosave), 고정(Pin) 기능, 마우스 드래그블 스플리터 제공 |
| **💾 통합 백업 / 복원** | • **Zero-Memory Python 백엔드 스트리밍 아키텍처** (브라우저 메모리 소모 최소화)<br>• 중앙 SQLite DB 및 설정을 **단일 JSON 및 90% 압축 ZIP 포맷으로 일괄/선택적 내보내기 & 복원(Merge/Replace)** |
| **🛡️ 시스템 트레이 & 런타임 제어** | • **웹 UI 기반 백엔드 전원 제어**: 상단 헤더 및 시스템 탭에서 1-클릭 서버 완전 종료 및 즉시 재시작(Hot Reload) 지원<br>• **독립 브라우저 프로파일 격리**: `data/browser_profile` 분리로 Chrome 기본 프로파일 점유 및 확장프로그램 인증키 간섭 100% 방지<br>• **Windows Named Semaphore** 기반 단일 인스턴스 락(중복 실행 방지 및 기존 창 자동 활성화)<br>• 검은색 콘솔 창 없는 GUI 구동(`run.pyw`), Windows 시스템 트레이 상주 (`utiltools.ico`), V8 힙 128MB 제한 및 Windows WorkingSet 유휴 RAM 자동 회수 |

---

## 📖 상세 기술 문서 (Architecture & Deep-Dive Technical Docs)

각 기능별 핵심 백엔드 아키텍처, 알고리즘, 데이터베이스 스키마 및 세부 구현 명세는 [`docs/`](docs/) 디렉토리의 전용 기술 문서에서 체계적으로 관리됩니다:

| 문서명 | 주요 다루는 기술 영역 및 아키텍처 | 바로가기 링크 |
| :--- | :--- | :--- |
| **🤝 Handover Guide (인수인계서)** | • **개발 환경 셋업, 핵심 수명주기 아키텍처, 작업 완료 전 무결성 검증 체크리스트**<br>• 경로 참조 원칙, 비차단 UI 규정 및 무결성 검증 파이프라인 | [📖 `docs/HANDOVER_GUIDE.md`](docs/HANDOVER_GUIDE.md) |
| **🤖 AI Coding Sessions Hub** | • **통합 AI 세션 허브: Antigravity CLI(`agy`) & OpenCodex(`ocx`) 듀얼 엔진 아키텍처**<br>• **5ms 논블로킹 활성 락 검사**, `mode=ro` SQLite 카탈로그 조회, 실시간 Live Tail 파서, 창 전환 | [📖 `docs/AI_CODING_SESSIONS.md`](docs/AI_CODING_SESSIONS.md) |
| **🗄️ Database Architecture & Schema** | • **중앙 SQLite DB(`data/app.db`) 13개 테이블 전체 ERD & 스키마 명세**<br>• WAL 모드 및 고성능 PRAGMA 최적화, 인덱스 커버리지, 외부 AI CLI DB 연동 규격 | [📖 `docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) |
| **🦊 Redmine Integration** | • **Redmine REST API 연동, 일감/위키 대시보드, SQLite 오프라인 캐시**<br>• **주요 관심 프로젝트(⭐ 즐겨찾기) 우선순위 필터링**, 백그라운드 폴링 & 트레이 알림 | [📖 `docs/REDMINE_INTEGRATION.md`](docs/REDMINE_INTEGRATION.md) |
| **📧 Email Archive System** | • **3,100+건 대용량 이메일 아카이브 & 대화별 스레드 타임라인 뷰어**<br>• 비파괴적 제목 정규화 알고리즘, 청크 페이징 & 지연 로딩 아키텍처 | [📖 `docs/EMAIL_ARCHIVE.md`](docs/EMAIL_ARCHIVE.md) |
| **🧠 AI Semantic Search Engine** | • **로컬 딥러닝 임베딩 신경망(`intfloat/multilingual-e5-small` ONNX)**<br>• 코사인 유사도 연산, 크로스 도메인 증분 벡터 캐시, `Ctrl+K` 검색 & 문장 비교 도구 | [📖 `docs/AI_SEMANTIC_SEARCH.md`](docs/AI_SEMANTIC_SEARCH.md) |
| **🎲 Mock Data Studio** | • **3-Pass 복합 가상 데이터 생성 파이프라인 (독립 ➔ 로마자/이메일 ➔ 종속 매핑)**<br>• 한국어 로마자 표기법 변환, 커스텀 서식 스키마 관리 및 엑셀(.xlsx)/CSV 스트리밍 | [📖 `docs/MOCK_DATA_STUDIO.md`](docs/MOCK_DATA_STUDIO.md) |
| **✂️ Image Slicer Studio** | • **Pillow 이미지 분할 파이프라인 & 인터랙티브 HTML5 캔버스**<br>• 다중 절단선, 자유 경계 박스, 고정 px, 균등 N등분, 여백 자동 감지 & ZIP 패킹 | [📖 `docs/IMAGE_SLICER.md`](docs/IMAGE_SLICER.md) |
| **📊 Data & Document Viewers** | • **CSV/TSV 테이블 뷰어** (인코딩/구분자 자동 감지, MD/JSON/SQL 변환)<br>• **Markdown Studio** (GitHub Alerts, 양방향 태스크 동기화, TOC) & **Mermaid 다이어그램** | [📖 `docs/DATA_VIEWERS.md`](docs/DATA_VIEWERS.md) |
| **💾 Zero-Memory Backup & Restore** | • **Zero-Memory Python 디스크 직접 스트리밍 아키텍처** (브라우저 메모리 소모 최소화)<br>• 90% 압축 ZIP 포맷, 2대 복원 모드(Merge vs Replace) & SQLite 원자적 일괄 복원 | [📖 `docs/BACKUP_AND_RESTORE.md`](docs/BACKUP_AND_RESTORE.md) |
| **🛠️ Core System & Utilities** | • **웹 UI 서버 전원 제어 & 재시작**, 브라우저 프로파일 격리, 단일 인스턴스 세마포어, pystray 트레이<br>• Google Calendar/iCal 동기화, JS 샌드박스 런너, 빠른 실행 & 데스크톱 UI 런타임 현대화 로드맵 | [📖 `docs/CORE_AND_UTILITIES.md`](docs/CORE_AND_UTILITIES.md) |

---

## 📂 프로젝트 모듈 아키텍처 (Project Structure)

```text
D:\python
│
├── main.py                     # [진입점] 단일 인스턴스 검증, Eel 초기화 및 서비스 모듈 바인딩
├── run.pyw                     # [런처] Windows 무창(Windowless) 백그라운드 실행기
├── UtilTools.spec              # [패키징] PyInstaller 독립 폴더(--onedir) 빌드 정의서
├── build.bat                   # [빌드] PyInstaller 데스크톱 배포본 빌드 스크립트
├── requirements.txt            # 필수 Python 패키지 목록
├── utiltools.ico               # 애플리케이션 & 시스템 트레이 아이콘
│
├── docs/                       # [기술 문서] 10대 기능별 상세 아키텍처 및 기획서
│   ├── plans/                  # [기획 문서] 세션 센터, 런처 통합 등 구현 기획서 보관소
│   ├── AI_CODING_SESSIONS.md   # 통합 AI 코딩 세션 허브: Antigravity CLI & OpenCodex 듀얼 엔진 아키텍처
│   ├── DATABASE_SCHEMA.md      # 중앙 SQLite DB(app.db) 13개 테이블 ERD 및 상세 스키마 명세
│   ├── REDMINE_INTEGRATION.md  # Redmine REST API 연동, 일감/위키, 주요 프로젝트⭐ 우선순위
│   ├── EMAIL_ARCHIVE.md        # 대용량 이메일 아카이브 & 대화 스레드 타임라인 아키텍처
│   ├── AI_SEMANTIC_SEARCH.md   # 로컬 ONNX 신경망 임베딩 및 AI 시맨틱 검색 엔진
│   ├── MOCK_DATA_STUDIO.md     # 3-Pass 복합 가상 데이터 생성기 & 엑셀/CSV 스트리밍
│   ├── IMAGE_SLICER.md         # Pillow 이미지 슬라이서, 다중 절단선 & 여백 감지
│   ├── DATA_VIEWERS.md         # CSV/TSV 테이블 뷰어, Markdown Studio & Mermaid 렌더러
│   ├── BACKUP_AND_RESTORE.md   # Zero-Memory 백엔드 스트리밍 백업 & 원자적 복원 엔진
│   └── CORE_AND_UTILITIES.md   # 시스템 트레이, 웹 UI 전원 제어, 브라우저 격리, 세마포어 싱글턴
│
├── templates/                  # [기본 서식] 최초 실행 시 DB/설정 초기화용 템플릿 (*.example.json 8종)
│
├── data/                       # [사용자 데이터] SQLite 중앙 데이터베이스 (Git 제외)
│   ├── app.db                  # emails, notes, diagrams, redmine, quick_launch 등 13개 테이블
│   └── browser_profile/        # [브라우저 격리] 독립 사용자 프로파일 디렉토리 (Git 제외)
│
├── emails/                     # [개인 데이터] 로컬 저장된 원본 .eml 파일 보관소 (Git 제외)
│
├── models/                     # [AI 모델] 로컬 신경망 임베딩 모델 (Git 제외)
│   └── multilingual-e5-small/  # ONNX 양자화 모델 (model_quantized.onnx) 및 토크나이저
│
├── core/                       # [코어 시스템]
│   ├── __init__.py
│   ├── paths.py                # 개발 모드 & 배포본(.exe) 중앙 표준 경로 관리자
│   ├── single_instance.py      # Windows Named Semaphore 기반 단일 인스턴스 중복 방지 매니저
│   ├── logger.py               # 백엔드/프론트엔드 통합 시스템 이벤트 로거
│   └── tray.py                 # pystray 트레이 아이콘, 윈도우 생명주기 및 트레이 알림 관리자
│
├── services/                   # [백엔드 서비스 모듈 (Python)]
│   ├── __init__.py
│   ├── agy_service.py          # 통합 AI 세션 컨트롤러, Antigravity CLI 파서, 감시(알림/승인 대기) & 삭제 라우팅
│   ├── opencodex_service.py    # OpenCodex(ocx) SQLite 세션 카탈로그, 5ms 파일 락, rollout 파서 & 창 전환
│   ├── system_service.py       # 웹 UI 기반 서버 완전 종료, Hot Reload(재시작) 및 단일 인스턴스 락 인계
│   ├── db_service.py           # 중앙 SQLite WAL 모드 커넥션 풀 & 스키마 관리자
│   ├── ai_search_service.py    # ONNX AI 시맨틱 검색 & 벡터 캐시 엔진
│   ├── email_service.py        # EML 파서, 스레드 정규화, 카테고리 분류 & 첨부파일 추출
│   ├── redmine_service.py      # Redmine REST API 연동 (일감, 위키, 메타데이터, SQLite 캐시)
│   ├── mock_data_service.py    # 3-Pass 모의 데이터 생성, 로마자 변환 & 엑셀/CSV 빌더
│   ├── csv_service.py          # CSV/TSV 파서, 인코딩/구분자 자동 감지 및 저장
│   ├── markdown_service.py     # Markdown 파일 열기/저장 및 인코딩 감지 백엔드
│   ├── notes_service.py        # 빠른 메모/스크래치패드 SQLite CRUD
│   ├── diagram_service.py      # Mermaid 다이어그램 SQLite CRUD
│   ├── generator_service.py    # 커스텀 데이터 생성기 SQLite CRUD
│   ├── quick_launch_service.py # 빠른 실행/SSH/URL SQLite CRUD
│   ├── shortcuts_service.py    # 폴더 바로가기 SQLite CRUD 및 터미널 런처
│   ├── calendar_service.py     # 구글 캘린더 / iCal(ICS) 파싱 및 일정 동기화
│   ├── settings_service.py     # 창 크기/테마/agy 연동 설정 영구 관리
│   ├── backup_service.py       # 전체 데이터 통합 JSON/ZIP 백업/복원 레지스트리
│   └── dialog_service.py       # Tkinter 기반 파일/폴더 선택 대화상자
│
└── web/                        # [프론트엔드 리소스]
    ├── index.html              # 메인 UI 마크업 (헤더 전원 제어, 드롭다운 메뉴, AI 세션 허브)
    ├── style.css               # 모던 다크 테마 CSS, AI 세션 뱃지, Live Tail & 헤더 스타일
    ├── utiltools.ico           # 브라우저 창 Favicon
    └── js/                     # [프론트엔드 모듈 (JavaScript)]
        ├── app.js              # 탭 전환 네비게이션, 드롭다운 그룹 제어 및 초기화
        ├── agy_sessions.js     # 통합 AI 세션 테이블, 듀얼 모드 알림, Live Tail 모달 & 영구 삭제
        ├── console.js          # 하단 로그창, 스플리터 조절기 & 고도화된 토스트(Toast) 알림
        ├── drag_drop.js        # 공통 마우스 드래그 앤 드롭 핸들러
        ├── email_viewer.js     # EML 아카이브, 대화 스레드 타임라인 & 온디맨드 뷰어
        ├── redmine.js          # Redmine 일감 대시보드, 타임라인, 상태변경 & 위키 에디터
        ├── ai_search.js        # AI 문맥 검색 & 문장 의미 비교 모달 UI (Ctrl+K)
        ├── mock_data_studio.js # 3-Pass 모의 데이터 스튜디오 & 서식 엑셀/CSV 생성 UI
        ├── csv_viewer.js       # CSV/TSV 데이터 뷰어, 정렬, 검색, 변환/내보내기
        ├── markdown_viewer.js  # Markdown 실시간 뷰어/에디터, GFM/Mermaid 렌더러
        ├── notes.js            # 빠른 메모 / 스크래치패드 실시간 에디터 및 자동 저장
        ├── calendar.js         # 월간 캘린더, 일정 동기화, Agenda 및 구독 관리
        ├── mermaid_diagram.js  # Mermaid 렌더러, 줌/팬 인터랙션 및 SVG/PNG 내보내기
        ├── mermaid_templates.js # 다이어그램 템플릿 프리셋 모듈
        ├── generator.js        # 커스텀 데이터 생성기 스튜디오 UI
        ├── js_runner.js        # JS 플레이그라운드 (AsyncFunction 샌드박스 엔진)
        ├── quick_launch.js     # 빠른 실행 렌더링, 인라인 편집 & 파일 선택 연동
        ├── shortcuts.js        # 폴더 바로가기 렌더링, 인라인 편집 & 터미널 런처
        ├── backup.js           # 통합 백업/복원 모달 제어 (JSON/ZIP Export/Import)
        └── system.js           # 시스템 사양, 백엔드 전원 제어([🔄 재시작], [🚪 종료]) 연동
```

---

## 🚀 설치 및 실행 방법 (Getting Started)

### 1. 필수 패키지 설치

Python 3.10 이상 환경에서 아래 명령어를 실행하여 필수 의존성을 설치합니다:

```powershell
pip install -r requirements.txt
```

*(설치 패키지: `eel`, `pystray`, `pillow`, `openpyxl`, `numpy`, `onnxruntime`, `tokenizers`)*

---

### 2. 실행 방법

#### 방법 A: 더블클릭으로 바로 실행 (권장 🌟)
탐색기에서 **`run.pyw`** 파일을 더블클릭하면 검은색 CMD 콘솔 창 없이 백그라운드 트레이로 즉시 실행됩니다.  
*(이미 실행 중인 경우 Windows Named Semaphore가 감지하여 기존 창을 화면 맨 앞으로 자동 복원합니다.)*

#### 방법 B: 터미널 명령어로 실행
```powershell
# 콘솔 창 없이 백그라운드 실행
pythonw run.pyw

# 또는 개발/디버깅용 콘솔 모드로 실행
python main.py
```

---

## 📦 데스크톱 독립 실행 파일 빌드 (Packaging)

별도의 파이썬 설치 없이 어디서든 즉시 실행할 수 있는 독립 포터블 패키지(`dist/UtilTools/UtilTools.exe`)를 생성하려면:

1. 프로젝트 루트의 **`build.bat`** 파일을 더블 클릭하여 실행합니다.
2. 빌드가 완료되면 **`dist\UtilTools\`** 폴더가 생성됩니다.
3. 해당 폴더를 그대로 압축하여 배포하거나, `UtilTools.exe`의 바로가기를 바탕화면에 생성하여 사용합니다.

---

## ⌨️ 주요 단축키 및 사용 가이드

* **AI 시맨틱 문맥 검색**:
  * `Ctrl + K`: 언제 어디서나 AI 시맨틱 검색 모달 즉시 호출
* **통합 AI 코딩 세션 허브 (Antigravity & OpenCodex)**:
  * 세션 행 **`[⚡ 실행]`**: 해당 프로젝트 디렉토리에서 대화형 터미널 즉시 오픈 또는 이미 열려 있는 콘솔 창 화면 전면 전환
  * 세션 행 **`[🔍 보기]`**: 인앱 실시간 Live Tail 모달 호출 (프롬프트, 사고 과정, 도구 호출 및 결과 스트리밍 열람)
  * 세션 행 **`[🗑️]`**: 비활성 세션 영구 삭제 (비차단 확인 모달 후 정리, 실행 중인 활성 세션은 삭제 방어)
  * 상단 필터 바: 엔진별(`전체`/`AGY`/`OpenCodex`) 라디오 필터 및 `📁 프로젝트 ▾` 멀티 체크박스 고속 필터링
  * 알림 종 모양 클릭: `1회 알림 (One-Shot)` vs `지속 알림 (Persistent)` 선택
* **웹 UI 백엔드 전원 제어**:
  * 상단 헤더 **`[🔄 재시작]`**: SQLite WAL 동기화 및 세마포어 해제 후 수정된 파이썬 코드를 반영하여 즉시 재시동 (Hot Reload)
  * 상단 헤더 **`[🚪 종료]`**: 비차단 확인 후 백엔드 프로세스 및 시스템 트레이 완전 종료
* **JS 실행기 단축키**:
  * `Ctrl + Enter` (또는 `Cmd + Enter`): 작성한 자바스크립트 코드 즉시 실행
  * `Tab` 키: 4칸 들여쓰기(`    `) 삽입
* **목록 순서 변경**:
  * `[⚙️ 편집]` 팝업에서 각 항목의 `⋮⋮` 핸들을 마우스로 끌어서 원하는 위치에 드롭
* **시스템 트레이**:
  * 작업표시줄 트레이 아이콘 **더블클릭** 또는 **우클릭 -> `[🛠️ 도구 모음 열기]`**: 프로그램 창 표시
  * 트레이 우클릭 -> **`[🚪 완전히 종료]`**: 백그라운드 프로세스 완전 종료

---

## 📄 라이선스 (License)

이 프로젝트는 [MIT License](LICENSE)에 따라 자유롭게 사용, 수정, 배포 및 상업적 이용이 가능합니다. 전문은 [LICENSE](LICENSE) 파일을 참조하십시오.
