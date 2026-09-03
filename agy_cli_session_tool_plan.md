# 🤖 agy-cli 세션 목록화 및 상호작용 도구 연동 계획서

본 문서는 Util-Tools 내에 **Antigravity CLI(`agy`)**의 세션 목록을 조회하고, 특정 세션과 상호작용(터미널 열기 또는 프롬프트 송수신)할 수 있는 도구를 추가하기 위한 구현 계획서입니다.

---

## 1. 🚨 확인 사항: 별도 DB 테이블 생성 불필요

> [!NOTE]
> **별도의 DB 테이블을 새로 생성할 필요가 전혀 없습니다.**
> `agy-cli` 자체 시스템이 세션 히스토리(`conversation_summaries.db`, `history.jsonl`, `brain/` 디렉토리)를 이미 로컬에 자동으로 보관하고 있습니다.
> 따라서 Util-Tools 백엔드는 이 기존 데이터를 **단순 읽기(Read-Only)**만 수행하며, 새로운 테이블을 생성하거나 스키마를 변경하지 않습니다.

---

## 2. agy-cli 세션 목록화 및 상호작용 가능 여부 분석

**결론: 기술적으로 충분히 가능하며, 매우 유용한 기능이 될 수 있습니다.**

### 2-1. 세션 목록 및 워크스페이스 위치 추출 (Read-only)
- **데이터 소스**:
  - `C:\Users\jrwoo\.gemini\antigravity-cli\conversation_summaries.db`
- **`workspace_uris` 컬럼 검증 완료**:
  - 실제 DB 확인 결과, 각 세션마다 작업했던 워크스페이스 디렉토리 경로가 JSON 배열 형태로 보관되어 있습니다:
    - `["file:///D:/python"]`
    - `["file:///d%3A/python"]`
    - `["file:///D:/workspace/server-setup"]`
    - `["file:///D:/workspace/logParser"]`
- **추출 및 파싱 정보**:
  - `conversation_id`: 세션 고유 UUID (예: `cfb67627-9eae-4974-aa88-e01c520c4695`)
  - `preview` / `title`: 세션 요약 제목 (예: "Current Project Status Recap")
  - `last_modified_time`: 마지막 작업 일시 (정렬 기준)
  - `step_count`: 진행된 대화 스텝 수 (예: 399단계)
  - `workspace_path`: `urllib.parse`로 파싱한 실제 Windows 디렉토리 경로 (예: `D:\python`, `D:\workspace\server-setup`)
- **주요 활용 이점**:
  1. **프로젝트별 필터링**: `[전체 세션]` / `[현재 프로젝트 (D:\python)]` 토글 필터 지원.
  2. **정확한 경로에서 터미널 오픈**: 세션 실행 시 해당 세션의 원래 작업 디렉토리로 즉시 `cd`하여 `agy --conversation <id>` 실행 가능.

---

### 2-2. 상호작용(Interaction) 방식 2가지 옵션

#### [옵션 1 (권장 🌟)] 원클릭 외부 CLI 터미널 런처
- **동작**: 앱 내 세션 카드에서 `[⚡ 터미널 열기]`를 클릭하면, Windows Terminal/CMD/PowerShell 새 창이 즉시 실행되며 해당 세션이 자동으로 이어집니다:
  ```powershell
  wt.exe -d "D:\python" agy --conversation <conversation_id>
  # 또는
  cmd.exe /c start cmd.exe /k "cd /d D:\python && agy --conversation <conversation_id>"
  ```
- **장점**:
  - `agy` 고유의 TUI, 실시간 스트리밍, 대화형 도구 승인, 슬래시 커맨드 등 모든 기능을 100% 온전히 사용할 수 있음.
  - 앱과 agy 프로세스 간의 복잡한 IPC 락(Lock)이나 stdin/stdout 파이프라인 충돌 위험이 전혀 없음.

#### [옵션 2] 앱 내 인라인 프롬프트 송수신 (Print 모드)
- **동작**: 앱 내에서 텍스트를 입력하고 전송 버튼을 누르면, 백엔드가 `subprocess`로 agy를 실행하여 결과를 수신:
  ```powershell
  agy --conversation <conversation_id> --print "<사용자 입력>" --output-format json
  ```
- **장점**: 브라우저 창 안에서 바로 질문하고 답변을 확인 가능.
- **주의점**: agy가 도구 실행 승인(Permission Prompt)을 요구할 때 대화형 입력이 필요하므로, `--dangerously-skip-permissions` 옵션이나 스트림 제어가 필요함.

---

## 3. ⚙️ 기능 사용 여부 설정 (Feature Toggle Architecture)

`agy`는 Antigravity CLI 전용 도구이므로, 사용자가 원할 때만 기능을 켜고 끌 수 있는 **선택적 활성화(Feature Toggle)** 구조로 설계합니다.

### 3-1. 설정 영속화 (`data/app_settings.json`)
- [`services/settings_service.py`](file:///D:/python/services/settings_service.py)의 `DEFAULT_SETTINGS`에 플래그 추가:
  ```json
  {
    "enable_agy_integration": false
  }
  ```
- **기본값은 `false`(OFF)**로 설정하여, 명시적으로 켜지 않는 한 일반 사용자 환경에 어떠한 영향도 주지 않습니다.

### 3-2. 토글 UI 위치 (`🖥️ 시스템 & 네트워크` 탭)
- 시스템 도구 그리드에 **`[⚙️ 외부 도구 연동 / 실험실]`** 카드 또는 전용 토글 행 추가:
  - **아이콘 및 명칭**: `🤖 Antigravity CLI (agy) 연동`
  - **설명**: "로컬 agy CLI 세션 목록을 조회하고 작업 폴더에서 즉시 터미널을 이어 실행합니다."
  - **컨트롤**: `[스위치 토글 (ON / OFF)]`
  - **상태 배지**: 시스템 내 `~/.gemini/antigravity-cli` 환경 감지 시 `[감지됨]` 녹색 배지 표시.

### 3-3. 활성화 상태에 따른 동작 분기
- **OFF (비활성화 상태)**:
  - 앱 전체에서 agy 관련 UI, 버튼, 세션 목록 섹션이 100% 숨김 처리됩니다.
  - 백엔드 파일 접근 및 프로세스 호출이 일체 발생하지 않아 리소스 점유율 0% 유지.
- **ON (활성화 상태)**:
  - `⚡ 빠른 실행` 탭 내에 `[🤖 Antigravity CLI 세션 바로가기]` 섹션이 나타나며, 최근 작업 세션 카드와 터미널 실행 버튼이 활성화됩니다.

---

## 4. UI 배치 방안 (활성화 시)

`enable_agy_integration: true`로 켜졌을 때의 UI 노출 방안:

1. **`⚡ 빠른 실행` 탭 내부 3번째 섹션으로 노출 (추천 🌟)**:
   - 상단: `📁 폴더 바로가기`
   - 중단: `⚡ 프로그램 & 도구 빠른 실행`
   - 하단: `🤖 Antigravity CLI 세션 (최근 5~10건 & 프로젝트 필터)`
2. **또는 독립 모달 팝업 (`[🤖 agy 세션 매니저]` 모달)**:
   - 시스템 탭의 agy 카드에서 `[세션 목록 열기]` 클릭 시 모달 팝업으로 세션 검색 및 터미널 런처 제공.

---

## 5. 검증 계획 (Verification Plan)

1. **설정 토글 테스트**: `app_settings.json`에서 `enable_agy_integration` ON/OFF 변경 시 UI 노출/숨김이 실시간으로 반응하는지 확인.
2. **세션 목록 읽기 테스트**: `conversation_summaries.db`에서 현재 워크스페이스(`D:/python`) 세션들을 파싱하여 JSON 변환 속도 및 데이터 정확성 확인 (< 5ms).
3. **세션 이어하기 실행 테스트**: 세션 카드 클릭 시 원래 작업 경로로 이동하여 `agy --conversation <id>`가 새 터미널 창으로 정상 오픈되는지 확인.
