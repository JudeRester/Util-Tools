# 🛠️ 코어 시스템 및 유틸리티 아키텍처 (Core System & Utilities Architecture)

Util-Tools는 무창(Windowless) 백그라운드 상주, 시스템 트레이 연동, 메모리 자동 회수, 일정 동기화, 빠른 실행, 그리고 자바스크립트 샌드박스를 통합 지원하는 견고한 데스크톱 런타임 프레임워크를 기반으로 동작합니다.

---

## 1. 🏛️ 애플리케이션 생명주기 및 시스템 트레이

```mermaid
stateDiagram-v2
    [*] --> WindowlessLauncher : run.pyw 더블클릭 (pythonw.exe)
    
    state WindowlessLauncher {
        [*] --> CheckSingleInstance : 싱글 인스턴스 검사
        CheckSingleInstance --> InitTray : pystray 시스템 트레이 초기화
        InitTray --> StartEelServer : 백그라운드 비동기 Eel 서버 기동
    }
    
    WindowlessLauncher --> HiddenState : 트레이 상주 (검은색 콘솔 창 0)
    
    HiddenState --> WindowActive : 트레이 더블클릭 / 열기
    WindowActive --> HiddenState : 창 닫기(X) / 최소화 -> 트레이 숨김 & RAM 자동 회수
    WindowActive --> Shutdown : 트레이 [🚪 완전히 종료] 클릭
    HiddenState --> Shutdown : 트레이 [🚪 완전히 종료] 클릭
    
    Shutdown --> [*] : WAL Checkpoint 병합 & 프로세스 완전 종료
```

### 1-1. 무창(Windowless) 백그라운드 실행 (`run.pyw`)
- 검은색 CMD 프롬프트 창이 일체 표시되지 않는 `pythonw.exe` 런처를 제공합니다.
- 사용자가 창을 닫더라도 프로세스가 꺼지지 않고 시스템 트레이로 숨겨져 백그라운드 동기화(Redmine, 캘린더 등)를 지속합니다.

### 1-2. 중앙 트레이 관리자 (`core/tray.py`)
- Windows 알림 영역(트레이)에 고해상도 다크 테마 아이콘(`utiltools.ico`) 상주.
- **메뉴 구성**:
  - `🛠️ 도구 모음 열기 (기본값 / 더블클릭)`
  - `🔄 백그라운드 동기화 확인`
  - `🚪 완전히 종료`

---

## 2. ⚡ 메모리 최적화 및 유휴 자원 자동 회수 엔진

상시 실행되는 데스크톱 앱의 특성상 메모리 누수 방지와 저사양 PC 배려가 최우선 과제입니다:

1. **V8 힙 메모리 엄격 제한**:
   - Eel(Chrome/Edge) 프로세스 구동 시 `--js-flags=--max-old-space-size=128` 파라미터를 강제하여 브라우저 엔진의 불필요한 캐시 팽창을 원천 억제.
2. **Windows WorkingSet 유휴 메모리 자동 회수**:
   - 창이 최소화되거나 트레이로 숨겨질 때 Windows API `psapi.EmptyWorkingSet(handle)`을 호출하여 사용하지 않는 페이지를 OS로 즉각 반환 (RAM 점유율을 30MB 수준으로 압축).
3. **유휴 시 0% CPU**:
   - 주기적 폴링 타이머 외에는 모든 스레드가 대기(Sleep/Wait) 상태를 유지하여 노트북 배터리 소모가 없습니다.

---

## 3. 📅 구글 캘린더 및 iCal(ICS) 웹 일정 동기화

- **비공개 주소 실시간 파싱**: 구글 캘린더의 비공개 iCal 웹 주소(`https://calendar.google.com/calendar/ical/.../basic.ics`)를 등록하면 백엔드 `calendar_service.py`가 주기적으로 일정을 수신하여 분석.
- **다크 테마 월간 캘린더**: 날짜별 일정 뱃지와 당일 일정(Today's Agenda) 상세 뷰 제공.
- **설정 보관**: `calendar_config.json`에 암호화된 형식으로 구독 주소 보관.

---

## 4. ⚡ 빠른 실행(Quick Launch) & 폴더 바로가기

- **빠른 실행 (`quick_launch`)**:
  - 개발 서버 구동 스크립트(`.bat`), 데스크톱 실행 파일(`.exe`), 웹 관리자 페이지(URL), SSH 접속 명령어를 원클릭으로 실행.
  - 드래그 앤 드롭으로 카드 순서 변경 (`order_index`).
- **폴더 바로가기 (`shortcuts`)**:
  - 자주 접근하는 프로젝트 디렉토리를 원클릭으로 탐색기에서 열기.
  - 상단 인라인 버튼을 통해 **해당 디렉토리 위치에서 PowerShell 또는 CMD 터미널 즉시 실행**.

---

## 5. 🧪 자바스크립트 샌드박스 플레이그라운드 (`web/js/js_runner.js`)

- RunJS / JSFiddle 스타일의 경량 코드 샌드박스.
- `AsyncFunction` 런타임 격리를 통해 최신 비동기 문법(`await fetch()`, `Promise` 등) 완벽 지원.
- `console.log`, `console.warn`, `console.error` 출력을 실시간 캡처하여 하단 인터랙티브 콘솔에 포맷팅 렌더링.
- `Ctrl + Enter` 즉시 실행 및 코드 자동 영구 저장.

---

## 6. 🔢 커스텀 데이터 생성기 스튜디오 (`generators`)

- 사용자가 직접 JavaScript 스크립트를 작성하여 새로운 고유 번호, 테스트 코드, 식별자 생성기를 무제한 확장.
- **동적 변수 바인딩 (`variables_json`)**: 사용자 입력 폼(텍스트, 숫자, 선택)을 생성기 카드 상단에 동적으로 렌더링하고 스크립트 실행 컨텍스트에 파라미터로 주입.
