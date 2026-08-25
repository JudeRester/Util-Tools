# 🛠️ Utility Toolkit (유틸리티 도구 모음)

Python **Eel**과 **HTML5/CSS/JavaScript** 기반의 모던 다크 테마 데스크톱 유틸리티 도구 모음입니다.  
검은색 CMD 콘솔 창 없이 백그라운드 시스템 트레이에 상주하며 개발 및 업무에 필요한 다양한 도구들을 빠르게 실행할 수 있습니다.

---

## 🌟 주요 기능 (Key Features)

| 카테고리 | 주요 제공 기능 |
| :--- | :--- |
| **🖥️ 시스템 정보** | • OS 사양, CPU, 메모리, Python 버전 확인<br>• 내부망(Local) IP 및 **공인 IP (Public IP)** 실시간 조회<br>• 현재 날짜/시간/ISO 타임스탬프 반환 및 서버 Ping 테스트 |
| **⚡ 빠른 실행** | • 자주 쓰는 앱/실행 파일(`.exe`, `.bat`), **SSH 터미널 접속**, **웹 URL**, **PowerShell 명령** 원클릭 실행<br>• **[⚙️ 편집]** 팝업을 통한 항목 추가, 인라인 수정(`✏️`), 삭제, 탐색기 파일 선택<br>• **마우스 드래그 앤 드롭(`⋮⋮`)** 및 `▲/▼` 버튼을 통한 실시간 순서 변경 |
| **📁 파일 / 폴더** | • 프로젝트 작업 디렉토리 바로가기 카드 목록<br>• 상단 우측 인라인 드롭다운을 통해 **원하는 폴더 위치에서 PowerShell / CMD 즉시 실행**<br>• 탐색기 대화상자 기반 폴더 추가/수정/삭제/드래그 앤 드롭 순서 변경 |
| **📋 CSV 뷰어** | • **대용량 CSV / TSV / 테이블 데이터 초고속 렌더링 & 뷰어**<br>• 인코딩(UTF-8, CP949/EUC-KR) 및 구분자(쉼표, 탭, 세미콜론, 파이프) **자동 감지**<br>• 드래그 앤 드롭 파일 로드, 클립보드(`Ctrl+V`) 표 데이터 즉시 붙여넣기<br>• 컬럼별 정렬(숫자/문자/날짜), 전역 실시간 검색 및 하이라이팅, 페이지네이션<br>• **Markdown 표, JSON 배열, SQL INSERT 문, 필터된 CSV** 원클릭 변환/다운로드 |
| **📝 Markdown 뷰어** | • **GFM(GitHub Flavored Markdown) 실시간 뷰어 & 에디터 (Markdown Studio)**<br>• **GitHub Alert 콜아웃**(`[!NOTE]`, `[!TIP]`, `[!WARNING]` 등 5종) 및 **Mermaid 다이어그램** 자동 시각화<br>• GFM 표, **인터랙티브 태스크 체크박스(클릭 시 소스 동기화)**, 코드 블록 구문 강조 및 복사<br>• Split(반반) / Editor / Preview 모드, 동기화 스크롤, **목차(TOC) 생성**, 실시간 통계 및 인쇄/PDF 저장 |
| **📊 다이어그램** | • **Mermaid 다이어그램 비주얼 스튜디오** (Flowchart, Sequence, Mindmap 등 16종 프리셋)<br>• 마우스 휠 줌 & 드래그 패닝, SVG/PNG 이미지 다운로드 및 클립보드 복사 |
| **📧 이메일 아카이브** | • **.eml / .msg 이메일 로컬 보관소 & 실시간 뷰어 (Git 격리 추적 제외)**<br>• **intfloat/multilingual-e5-small ONNX 신경망 기반 AI 시맨틱 문맥 검색(`Ctrl+K`) 연동**<br>• **메일 카테고리 자동/수동 분류** (업무/프로젝트, 회의록, 견적/계약, 인사/총무, 시스템/알림 등) 및 필터 칩<br>• HTML / 텍스트 본문 뷰어, 첨부파일 메타데이터 표시, Windows 기본 메일 앱(Outlook 등) 즉시 실행 연동 |
| **🔢 데이터 생성** | • **커스텀 데이터 생성기 스튜디오 (Custom Generator Studio)**<br>• 사용자가 직접 JavaScript 스크립트로 **새로운 생성기 추가/수정/순서 변경** 가능<br>• 기본 내장: 국세청 사업자번호, UUID v4, 16자리 강력 비밀번호, 한국인 가상 더미, 타임스탬프, 32자 HEX 토큰<br>• 원클릭 1개/5개 일괄 생성 및 클립보드 자동 복사 |
| **🧪 JS 실행기** | • JSFiddle / RunJS 스타일의 **JavaScript 코드 샌드박스** (비동기 `async/await` 완벽 지원)<br>• `console.log/warn/error` 출력 캡처 및 반환값(`return`), 실행 시간 측정<br>• `Ctrl + Enter` 실행, `Tab` 들여쓰기(4칸), 코드 자동 영구 보존 및 다양한 기본 템플릿 |
| **📝 빠른 메모** | • 자원 소모가 전혀 없는 **초경량 스크래치패드 / 메모장**<br>• 다중 메모 생성, 실시간 자동 저장(Autosave), 실시간 검색, 최근 수정/복사 시 상단 자동 정렬<br>• 메모 목록 & 에디터 간 **마우스 드래그블 스플리터(너비 자동 기억)** 제공<br>• `notes.example.json` 템플릿과 `notes.json` 로컬 저장소 분리로 민감 정보 Git 격리 |
| **📅 달력 & 일정** | • **구글 캘린더(Google Calendar) 및 iCal(ICS) 비공개 주소 실시간 구독 및 동기화**<br>• 다크 테마 월간 캘린더, 연/월 드롭다운 점프, 날짜별 일정 뱃지, 오늘의 일정(Today's Agenda) 상세 뷰<br>• 달력 & 일정 패널 간 **마우스 드래그블 스플리터(너비 자동 기억)** 및 구독 캘린더별 실시간 필터 칩 |
| **↕️ 스플리터** | • 하단 로그창(상하) 및 메모장/달력(좌우)을 **마우스 드래그로 자유롭게 크기 조절**<br>• 사용자가 조절한 크기는 로컬 스토리지에 자동 저장 및 복원 |
| **🛠️ 백그라운드 트레이** | • 검은색 CMD 창 없이 구동되는 순수 GUI 데스크톱 앱<br>• Windows 작업표시줄 **시스템 트레이(System Tray)** 상주 (`utiltools.ico` 아이콘 연동)<br>• 트레이 더블클릭/메뉴로 언제든지 창 열기 및 완전 종료 |

---

## 📂 프로젝트 모듈 아키텍처 (Project Structure)

```text
D:\python
│
├── main.py                     # [진입점] Eel 초기화 및 서비스 모듈 바인딩
├── run.pyw                     # [런처] Windows 무창(Windowless) 백그라운드 실행기
├── requirements.txt            # 필수 Python 패키지 목록
├── utiltools.ico               # 애플리케이션 & 시스템 트레이 아이콘
├── shortcuts.example.json      # 폴더 바로가기 기본 템플릿 (Git 버전 추적)
├── quick_launch.example.json   # 빠른 실행 기본 템플릿 (Git 버전 추적)
├── notes.example.json          # 빠른 메모 기본 템플릿 (Git 버전 추적)
├── calendar_config.example.json # 캘린더 구독 기본 템플릿 (대한민국 공휴일 iCal 포함)
├── diagrams.example.json       # 다이어그램 기본 템플릿 (Git 버전 추적)
├── emails.example.json         # 이메일 아카이브 기본 템플릿 (Git 버전 추적)
├── shortcuts.json              # [개인 데이터] 사용자 폴더 바로가기 (Git 제외)
├── quick_launch.json           # [개인 데이터] 사용자 빠른 실행/SSH/URL (Git 제외)
├── notes.json                  # [개인 데이터] 사용자 작성 메모 데이터 (Git 제외)
├── calendar_config.json        # [개인 데이터] 사용자 구글 캘린더 구독 주소 (Git 제외)
├── diagrams.json               # [개인 데이터] 사용자 저장 다이어그램 데이터 (Git 제외)
├── emails.json                 # [개인 데이터] 사용자 이메일 아카이브 메타데이터 (Git 제외)
├── emails/                     # [개인 데이터] 로컬 저장된 원본 .eml 파일 디렉토리 (Git 제외)
│
├── core/                       # [코어 시스템]
│   ├── __init__.py
│   └── tray.py                 # pystray 트레이 아이콘 및 윈도우 생명주기 관리자
│
├── services/                   # [백엔드 서비스 모듈 (Python)]
│   ├── __init__.py
│   ├── system_service.py       # 시스템 사양, Public/Local IP, Ping 테스트
│   ├── shortcuts_service.py    # 폴더 바로가기 CRUD, 탐색기/터미널(CMD/PS) 실행
│   ├── quick_launch_service.py # 빠른 실행 CRUD, 앱/SSH/URL/PowerShell 실행
│   ├── generator_service.py    # 사업자등록번호 체크섬 생성 알고리즘
│   ├── dialog_service.py       # Tkinter 기반 파일/폴더 선택 대화상자
│   ├── notes_service.py        # 빠른 메모/스크래치패드 CRUD 및 영속화
│   ├── calendar_service.py     # 구글 캘린더 / iCal(ICS) 파싱 및 일정 동기화
│   ├── diagram_service.py      # Mermaid 다이어그램 스튜디오 백엔드
│   ├── csv_service.py          # CSV/TSV 파서, 인코딩/구분자 자동 감지 및 저장
│   ├── markdown_service.py     # Markdown 파일 열기/저장 및 인코딩 감지 백엔드
│   ├── email_service.py        # EML 이메일 파서, 카테고리 분류, 저장 및 OS 앱 실행
│   ├── backup_service.py       # 전체 설정 데이터 통합 백업/복원
│   └── ai_search_service.py    # ONNX AI 시맨틱 검색 & 벡터 DB 캐시 엔진
│
└── web/                        # [프론트엔드 리소스]
    ├── index.html              # 메인 UI 마크업 (반응형 햄버거 메뉴 포함)
    ├── style.css               # 모던 다크 테마 CSS & 스플리터/모달/달력/메모 스타일
    ├── utiltools.ico           # 브라우저 창 Favicon
    └── js/                     # [프론트엔드 모듈 (JavaScript)]
        ├── app.js              # 탭 전환 네비게이션, 모바일 햄버거 제어 및 초기화
        ├── console.js          # 하단 로그 출력 헬퍼 & 스플리터 마우스 드래그 조절기
        ├── drag_drop.js        # 공통 마우스 드래그 앤 드롭(Drag & Drop) 핸들러
        ├── system.js           # 시스템 사양 & 타임스탬프 & Ping UI 연동
        ├── shortcuts.js        # 폴더 바로가기 렌더링, 인라인 편집 & 터미널 런처
        ├── quick_launch.js     # 빠른 실행 렌더링, 인라인 편집 & 파일 선택 연동
        ├── csv_viewer.js       # CSV/TSV 데이터 뷰어, 정렬, 검색, 변환/내보내기
        ├── markdown_viewer.js  # Markdown 실시간 뷰어/에디터, GFM/Mermaid 렌더러
        ├── email_viewer.js     # EML 이메일 아카이브, 카테고리 필터링, HTML 본문 뷰어
        ├── generator.js        # 사업자번호 생성기 & 클립보드 복사 로직
        ├── js_runner.js        # JS 플레이그라운드 (AsyncFunction 샌드박스 엔진)
        ├── notes.js            # 빠른 메모 / 스크래치패드 실시간 에디터 및 자동 저장
        ├── calendar.js         # 월간 캘린더, 일정 동기화, Agenda 및 구독 관리
        ├── mermaid_templates.js # 다이어그램 템플릿 프리셋 모듈
        ├── mermaid_diagram.js  # Mermaid 렌더러, 줌/팬 인터랙션 및 SVG 내보내기
        ├── backup.js           # 통합 백업/복원 모달 제어
        └── ai_search.js        # AI 문맥 검색 & 문장 의미 비교 UI
```

---

## 🚀 설치 및 실행 방법 (Getting Started)

### 1. 필수 패키지 설치

Python 3.10 이상 환경에서 아래 명령어를 실행하여 필수 의존성을 설치합니다:

```powershell
pip install -r requirements.txt
```

*(설치 패키지: `eel`, `pystray`, `pillow`)*

---

### 2. 실행 방법

#### 방법 A: 더블클릭으로 바로 실행 (권장 🌟)
탐색기에서 **`run.pyw`** 파일을 더블클릭하면 검은색 CMD 콘솔 창 없이 백그라운드 트레이로 즉시 실행됩니다.

#### 방법 B: 터미널 명령어로 실행
```powershell
# 콘솔 창 없이 백그라운드 실행
pythonw run.pyw

# 또는 개발/디버깅용 콘솔 모드로 실행
python main.py
```

---

## ⌨️ 주요 단축키 및 사용 가이드

* **JS 실행기 단축키**:
  * `Ctrl + Enter` (또는 `Cmd + Enter`): 작성한 자바스크립트 코드 즉시 실행
  * `Tab` 키: 다음 폼으로 넘어가지 않고 4칸 들여쓰기(`    `) 삽입
* **목록 순서 변경**:
  * **마우스 드래그**: `[⚙️ 편집]` 팝업에서 각 항목의 `⋮⋮` 핸들을 마우스로 끌어서 원하는 위치에 드롭
  * **버튼 이동**: `▲` / `▼` 버튼 클릭으로 한 칸씩 이동
* **항목 수정**:
  * `[⚙️ 편집]` 팝업에서 `[✏️]` 버튼을 누르면 상단 입력 폼에 기존 정보가 로드되며, 수정 후 `[💾 수정 완료]` 클릭
* **시스템 트레이**:
  * 작업표시줄 우측 하단 트레이 아이콘을 **더블클릭**하거나 **우클릭 -> `[🛠️ 도구 모음 열기]`** 선택 시 프로그램 창 표시
  * 트레이 우클릭 -> **`[🚪 완전히 종료]`** 선택 시 프로세스 완전 종료

---

## 📄 라이선스 (License)

이 프로젝트는 자유롭게 수정하고 사용할 수 있는 개인 유틸리티 툴킷입니다.
