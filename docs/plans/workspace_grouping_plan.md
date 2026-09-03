# 💼 업무 협업 도메인(달력·이메일·Redmine) 통합 상세 계획서

본 문서는 Util-Tools의 **달력 & 일정**, **이메일 아카이브**, **Redmine** 3대 기능을 단일 업무 협업 도메인으로 통합 구성하기 위한 아키텍처 및 UI 설계 계획서입니다.

---

## 1. 배경 및 통합 필요성 (Context & Goals)

현재 Util-Tools의 내비게이션 구조는 다음과 같은 비효율과 도메인 불일치가 존재합니다:

| 구분 | 현재 상태 | 문제점 |
| :--- | :--- | :--- |
| **📧 이메일 아카이브** | `📊 뷰어 / 다이어그램` 드롭다운 안에 배치 | CSV, Markdown, 다이어그램, 슬라이서 같은 **파일 뷰어** 도구들 사이에 업무 커뮤니케이션 도구인 이메일이 섞여 있어 인지적으로 부자연스러움 |
| **📅 달력 & 일정** | 상단 메인 탭에 독립 버튼으로 노출 | 독립 탭 개수가 많아져 좁은 화면에서 상단 탭 바가 복잡해짐 |
| **🦊 Redmine** | 상단 메인 탭에 독립 버튼으로 노출 | 일감 마감일과 일정이 달력과 분리되어 있어 업무 흐름이 단절됨 |

**통합 목적**:
- **업무 도메인 일원화**: 업무 요청/피드백(이메일) ↔ 프로젝트 일감/위키(Redmine) ↔ 일정/마감 관리(달력)를 하나의 영역으로 묶음.
- **뷰어 메뉴 순수화**: 기존 뷰어 드롭다운에서 이메일을 제외하고 `📄 파일 & 뷰어`(CSV, Markdown, 다이어그램, 슬라이서)로 순수 파일 열람 도구만 남김.
- **상단 메뉴 단순화**: 상단 탭 개수를 줄여 화면 공간을 확보하고 메뉴 탐색 동선을 직관적으로 개선.

---

## 2. 통합 아키텍처 옵션 비교 (Option 1 vs Option 2)

### 📌 옵션 1: 상단 내비게이션 드롭다운 그룹화 (Compact Dropdown)

상단 탭 바에 **`[💼 업무 & 협업 ▾]`** 드롭다운 버튼을 배치하고, 메뉴를 클릭하여 3대 화면으로 전환하는 방식입니다.

#### [UI 구조 및 동작 흐름]
```text
[상단 탭 바]
┌───────────┬──────────┬─────────┬──────────┬──────────┬──────────┬─────────────────┬───────────────────┐
│ 🖥️ 시스템 │ ⚡ 빠른실행 │ 📁 파일 │ 🔢 생성기 │ 🧪 JS실행 │ 📝 메모 │ 💼 업무 & 협업 ▾│ 📊 뷰어/다이어그램 ▾ │
└───────────┴──────────┴─────────┴──────────┴──────────┴──────────┴────────┬────────┴───────────────────┘
                                                                           │ (클릭 시 드롭다운 오픈)
                                                            ┌──────────────┴──────────────────┐
                                                            │ 🦊 Redmine      (프로젝트 일감)   │
                                                            │ 📅 달력 & 일정   (월간/구글 캘린더) │
                                                            │ 📧 이메일 아카이브(스레드 타임라인) │
                                                            └─────────────────────────────────┘
```
- **화면 전환**: 드롭다운에서 선택한 기능(Redmine/달력/이메일)이 메인 전체 영역을 사용합니다.
- **장점**:
  - 각 화면의 고유 레이아웃(Redmine의 좌/우 스플릿 뷰, 캘린더의 대형 월간 그리드, 이메일의 스레드 아코디언)이 온전히 유지됩니다.
  - 상단 탭 바가 8개로 대폭 슬림해집니다.
  - 구현이 단순하고 기존 DOM 구조를 거의 변경하지 않아 안정성이 높습니다.

---

### 📌 옵션 2: 단일 '업무 센터(Workspace)' 메인 탭 + 내부 서브탭 전환 (Unified Pane with Subtabs)

상단 탭 바에는 일반 탭 버튼인 **`[💼 업무 센터]`** 단 하나만 배치하고, 클릭 시 나타나는 화면 내부 상단에 **서브 내비게이션 바**를 두어 세 기능을 전환하는 방식입니다.

#### [UI 구조 및 동작 흐름]
```text
[상단 탭 바]
┌───────────┬──────────┬─────────┬──────────┬──────────┬──────────┬─────────────┬───────────────────┐
│ 🖥️ 시스템 │ ⚡ 빠른실행 │ 📁 파일 │ 🔢 생성기 │ 🧪 JS실행 │ 📝 메모 │ 💼 업무 센터 │ 📊 뷰어/다이어그램 ▾ │
└───────────┴──────────┴─────────┴──────────┴──────────┴──────────┴──────┬──────┴───────────────────┘
                                                                         │
                                                          (클릭 시 업무 센터 화면 진입)
                                                                         ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 💼 업무 센터 (Workspace)                                                                               │
│ ┌───────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │  [ 🦊 Redmine 일감 & 위키 ]     [ 📅 달력 & 일정 ]     [ 📧 이메일 아카이브 ]                       │ │  <- 내부 서브탭
│ └───────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                                       │
│  [선택된 서브탭의 메인 작업 영역]                                                                      │
│  - Redmine 선택 시: 일감 다중 필터바 + 좌/우 스플릿 목록/상세 뷰어                                    │
│  - 달력 선택 시: 월간 캘린더 그리드 + 오늘의 아젠다                                                  │
│  - 이메일 선택 시: 카테고리 사이드바 + 스레드 타임라인 뷰어                                           │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **화면 전환**:
  - 상단 메인 탭에서는 `💼 업무 센터` 버튼만 활성화됩니다.
  - 업무 센터 화면 안에서 상단 서브탭(`[🦊 Redmine]`, `[📅 달력]`, `[📧 이메일]`)을 클릭하여 하위 뷰를 전환합니다.
  - 탭 상태는 `workspaceSubTab: 'redmine' | 'calendar' | 'emails'` 상태 변수로 관리되며, 새로고침 시에도 마지막 보던 서브탭이 기억됩니다.
- **장점**:
  - **강력한 일체감**: 세 기능이 완전히 하나의 작업 공간(통합 워크스페이스) 안에서 유기적으로 묶여 있다는 사용자 경험을 제공합니다.
  - **상단 메뉴의 완전한 정돈**: 상단 메인 탭 바에 드롭다운 메뉴가 2개 생기지 않고, 순수 메인 탭 버튼들만 정갈하게 배치됩니다.
  - **향후 확장성**: 서브탭 우측 여백에 '오늘의 요약(오늘 마감 Redmine N건, 오늘 일정 N건)' 미니 상태 배지 등을 배치하기 매우 유리합니다.

---

## 3. 두 옵션 상세 비교 요약

| 비교 항목 | 옵션 1: 상단 드롭다운 그룹화 | 옵션 2: 단일 업무 센터 탭 + 내부 서브탭 |
| :--- | :--- | :--- |
| **상단 탭 바 외형** | `[💼 업무 & 협업 ▾]` 드롭다운 버튼 | `[💼 업무 센터]` 단일 일반 탭 버튼 |
| **기능 전환 방식** | 상단 드롭다운 메뉴를 열어 항목 선택 | 업무 센터 진입 후 상단 가로 서브탭 클릭 |
| **드롭다운 개수** | 2개 (`업무 & 협업 ▾`, `뷰어 / 다이어그램 ▾`) | 1개 (`뷰어 / 다이어그램 ▾`만 유지) |
| **화면 구조 변경폭** | 최소 (기존 각 탭의 HTML 컨테이너 그대로 유지) | 보통 (3개 섹션을 감싸는 `#tab-workspace` 래퍼 구성) |
| **세로 화면 공간** | 기존과 동일 (전체 높이 활용) | 서브탭 바 높이(약 40px)만큼 상단 사용 |
| **일체감 / UX** | 독립 화면들을 드롭다운으로 묶은 형태 | 단일 통합 업무 도구라는 강력한 공간 일체감 제공 |

---

## 4. 컴포넌트별 상세 수정 계획 (Proposed Code Changes)

### 4-1. 공통 수정 사항: 뷰어 드롭다운 정제 (`web/index.html`)
`#viewer-diagram-dropdown`에서 `emails`(이메일 아카이브) 항목을 제거하여 순수 파일 뷰어 4종만 남김:
- `📋 CSV 뷰어`
- `📝 Markdown 뷰어`
- `📊 다이어그램 (Mermaid)`
- `✂️ 이미지 슬라이서`

---

### 4-2. [옵션 2 선택 시] 세부 구현 명세

#### ① `web/index.html`
1. 상단 탭 버튼:
   - `data-tab="calendar"`, `data-tab="redmine"` 제거
   - `<button class="tab-btn" data-tab="workspace"><span class="tab-icon">💼</span> <span class="tab-label">업무 센터</span></button>` 추가
2. 섹션 래퍼 구조:
   ```html
   <section id="tab-workspace" class="tab-pane">
       <!-- 업무 센터 내부 서브 내비게이션 바 -->
       <div class="workspace-subnav-bar">
           <button type="button" class="workspace-subtab-btn active" data-subtab="redmine" onclick="switchWorkspaceSubTab('redmine')">
               <span class="subtab-icon">🦊</span> Redmine 일감 & 위키
           </button>
           <button type="button" class="workspace-subtab-btn" data-subtab="calendar" onclick="switchWorkspaceSubTab('calendar')">
               <span class="subtab-icon">📅</span> 달력 & 일정
           </button>
           <button type="button" class="workspace-subtab-btn" data-subtab="emails" onclick="switchWorkspaceSubTab('emails')">
               <span class="subtab-icon">📧</span> 이메일 아카이브
           </button>
       </div>

       <!-- 업무 센터 내부 하위 컨테이너 -->
       <div class="workspace-content-body">
           <div id="workspace-pane-redmine" class="workspace-subpane active">
               <!-- 기존 tab-redmine 내부 콘텐츠 삽입 -->
           </div>
           <div id="workspace-pane-calendar" class="workspace-subpane" style="display: none;">
               <!-- 기존 tab-calendar 내부 콘텐츠 삽입 -->
           </div>
           <div id="workspace-pane-emails" class="workspace-subpane" style="display: none;">
               <!-- 기존 tab-emails 내부 콘텐츠 삽입 -->
           </div>
       </div>
   </section>
   ```

#### ② `web/js/app.js`
1. 서브탭 전환 제어 함수 추가:
   ```javascript
   let currentWorkspaceSubTab = 'redmine';

   function switchWorkspaceSubTab(targetSubTab) {
       currentWorkspaceSubTab = targetSubTab;
       document.querySelectorAll('.workspace-subtab-btn').forEach(btn => {
           btn.classList.toggle('active', btn.dataset.subtab === targetSubTab);
       });
       document.querySelectorAll('.workspace-subpane').forEach(pane => {
           pane.style.display = (pane.id === `workspace-pane-${targetSubTab}`) ? 'block' : 'none';
       });

       // 지연 로딩 초기화 트리거
       if (targetSubTab === 'redmine') initTabOnDemand('redmine');
       else if (targetSubTab === 'calendar') initTabOnDemand('calendar');
       else if (targetSubTab === 'emails') initTabOnDemand('emails');

       saveAppSettingKey('workspace_subtab', targetSubTab);
   }
   ```
2. `switchTab('workspace')` 진입 시 `currentWorkspaceSubTab` 활성화 보장.

#### ③ `web/style.css`
- `.workspace-subnav-bar`: 깔끔한 가로 서브탭 바 디자인 (다크 테마 톤 일치, 슬림한 보더, 활성 탭 인디케이터).
- 높이 100% 플렉스 레이아웃을 적용하여 Redmine 스플릿 뷰나 이메일 뷰어가 스크롤 깨짐 없이 화면에 꽉 차도록 보장.

---

### 4-3. [옵션 1 선택 시] 세부 구현 명세

#### ① `web/index.html`
- 상단에 `#workspace-dropdown` 드롭다운 그룹 신설 (`Redmine`, `달력 & 일정`, `이메일 아카이브`).
- 기존 3개 개별 `<section id="tab-redmine">`, `<section id="tab-calendar">`, `<section id="tab-emails">` 위치 및 구조 그대로 유지.

#### ② `web/js/app.js`
- `toggleWorkspaceDropdown()`, `selectWorkspaceTab()` 함수 추가.
- `switchTab()`에서 해당 탭 활성화 시 드롭다운 트리거 버튼에 `active` 클래스 및 아이콘 동적 갱신.

---

## 5. 검증 계획 (Verification Plan)

### 구문 및 회귀 검사 (Automated)
```powershell
python -m py_compile services/*.py
node -c web/js/*.js
python -c "import re; t=open('web/style.css', encoding='utf-8').read(); c=re.sub(r'/\*.*?\*/','',t,flags=re.DOTALL); assert c.count('{')==c.count('}'), 'CSS brace mismatch!'; print('CSS OK')"
python -c "from core.paths import BUNDLE_DIR; from core.tray import TrayManager; tm = TrayManager(BUNDLE_DIR); assert tm.get_tray_image() is not None; print('Tray OK')"
Get-ChildItem web/js/*.js | ForEach-Object { node -c $_.FullName }; echo "All JS OK"
```

### 수동 기능 검증 (Manual)
1. **Redmine 기능**: 일감 목록 필터링, 상세 보기, 상태 변경, 위키 편집이 정상 작동하는지 확인.
2. **달력 기능**: 월간 일정 표시, Google Calendar 동기화, 날짜 클릭 시 아젠다 조회가 정상 작동하는지 확인.
3. **이메일 기능**: 스레드 타임라인 조회, 본문 뷰어, 카테고리 분류가 정상 작동하는지 확인.
4. **뷰어 메뉴**: `CSV 뷰어`, `Markdown 뷰어`, `다이어그램`, `이미지 슬라이서` 4종이 정상 작동하는지 확인.
5. **재부팅/새로고침**: 앱 재시작 시 마지막으로 보고 있던 탭/서브탭이 그대로 복원되는지 확인.
