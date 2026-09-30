# 🐛 [Issue #6] AI 세션 터미널 창 전환/실행 버튼 동작 불능 결함 조사 및 조치 계획서

## 1. 이슈 개요 (Issue Overview)

- **이슈 번호**: #6
- **이슈 제목**: AI 세션 허브 및 라이브 인스펙터의 터미널 창 전환/실행 버튼 동작 불능 결함
- **발견 시점**: Edge Quick Widget(`UtilTools_EdgeWidget`) 도입 이후 시점부터 발생
- **대상 모듈**:
  - 백엔드: [`services/agy_service.py`](file:///D:/python/services/agy_service.py), [`services/opencodex_service.py`](file:///D:/python/services/opencodex_service.py)
  - 프론트엔드: [`web/js/agy_sessions.js`](file:///D:/python/web/js/agy_sessions.js), [`web/index.html`](file:///D:/python/web/index.html)

---

## 2. 결함 증상 (Symptoms)

1. **인앱 라이브 인스펙터 모달**:
   - 하단의 `[⚡ 터미널 창 전환 / 열기]` 버튼 클릭 시 터미널 창이 화면 앞으로 올라오지 않고 아무런 반응이 없거나, 토스트에 "이미 열려 있는 세션 터미널 창을 화면 맨 앞으로 전환했습니다"라는 메시지만 표시된 후 터미널 창이 화면에 나타나지 않음.
   - 상단 권한 대기 알림 바의 `[⚡ 터미널로 이동]` 버튼 클릭 시에도 동일하게 터미널이 화면에 표시되지 않음.
2. **AI 세션 허브 카드 목록**:
   - 실행 중(Active)으로 표시된 세션 카드의 우측 `[⚡]`(터미널 창 전환 또는 열기) 버튼을 클릭해도 터미널 화면 전환이 되지 않고 앱 화면만 유지됨.

---

## 3. 원인 전수 조사 및 분석 결과 (Root Cause Analysis)

### 🚨 원인 ①: UtilTools 자체 프로세스(`pythonw.exe`) 및 `UtilTools_EdgeWidget` 오인 활성화 (핵심 원인)

- **발생 메커니즘**:
  1. `services/agy_service.py`의 `activate_session_terminal_window(conversation_id)` 함수는 세션 락 파일(`presence/<cid>.lock`)을 잠그고 있는 PID를 추적하기 위해 `_get_pids_locking_file()` (Windows Restart Manager)을 호출합니다.
  2. Windows OS의 파일 핸들 캐싱 및 검사 특성상, 세션 락을 조회하는 주체인 **UtilTools 백엔드 프로세스(`pythonw.exe`, 예: PID 33324)**도 잠금 관련 프로세스 목록에 포함되어 반환됩니다.
  3. `direct_target_pids`에 `os.getpid()` (UtilTools 자체)를 필터링하는 로직이 없어, UtilTools가 소유한 윈도우까지 탐색 대상에 포함됩니다.
  4. 데스크톱 윈도우 수집 루프에서 다음 코드가 실행됩니다:
     ```python
     matched_windows = []
     for hwnd, pid, title in windows:
         if pid in direct_target_pids:
             t_lower = title.lower()
             is_term = any(k in t_lower for k in ('powershell', 'terminal', 'cmd', 'agy', 'visual studio code', 'code'))
             matched_windows.append((is_term, hwnd, title))

     if matched_windows:
         matched_windows.sort(key=lambda x: x[0], reverse=True)
         best_hwnd = matched_windows[0][1]
         best_title = matched_windows[0][2]
         if _bring_window_to_front(best_hwnd):
             return True
     ```
  5. 여기서 `is_term`이 `False`인 윈도우(`UtilTools_EdgeWidget`)도 리스트에 그대로 추가됩니다.
  6. 만약 `is_term=True`인 터미널 창을 찾지 못하면, `matched_windows`의 유일한 요소인 `(False, hwnd, 'UtilTools_EdgeWidget')`가 선택됩니다.
  7. `_bring_window_to_front()`가 터미널이 아닌 **화면 가장자리 반투명 퀵 위젯(`UtilTools_EdgeWidget`)을 포커스**하고 `True`(성공)를 반환합니다.
  8. `launch_agy_session()`은 `activate_session_terminal_window()`가 `True`를 반환했으므로 터미널 창 전환이 성공했다고 오판하여, **새로운 터미널 창을 띄우는 3단계 로직을 실행하지 않고 즉시 종료**합니다.

- **실제 런타임 검증 증적**:
  ```text
  active_cids: {'ccab870e-...'}
  pids: [33324, 29568] (33324: pythonw.exe, 29568: agy.exe)
  matched: [(False, 2953292, 33324, 'UtilTools_EdgeWidget')]
  [INFO] [agy] PID/ConPTY 역추적 기반 터미널 창 활성화 성공: #ccab870e -> UtilTools_EdgeWidget
  activate: True
  ```

---

### 🚨 원인 ②: Windows Terminal 1.24+ 프로세스 트리 역추적 누락

- **Windows Terminal 프로세스 구조**:
  - 최신 Windows Terminal 환경에서는 다음과 같은 프로세스 트리를 가집니다:
    ```text
    WindowsTerminal.exe (PID: 66716)
       ├── openconsole.exe (PID: 43468)   <-- ConPTY 호스트 (conhost 대신 openconsole 사용)
       └── powershell.exe (PID: 65376)
             └── agy.exe (PID: 29568)
                   └── pwsh.exe (PID: 56888)
    ```
- **기존 역추적 로직의 2가지 결함**:
  1. 부모 역추적 화이트리스트(`'powershell', 'pwsh', 'cmd', 'code', 'conhost'`)에 **`'windowsterminal'`, `'openconsole'`, `'wt'`가 누락**되어, 부모를 거슬러 올라가다 `powershell.exe`의 부모인 `WindowsTerminal.exe`를 만나면 탐색이 중단되고 대상 PID에 포함되지 못함.
  2. ConPTY 판단 루프(`if 'conhost' in info.get('name', ''): has_conpty = True`)에서 **`'openconsole'`을 검사하지 않아**, 최신 Windows Terminal 환경에서 `has_conpty`가 항상 `False`로 판정됨.
  3. 그 결과, 실제 실행 중인 터미널 창인 `WindowsTerminal.exe`가 탐색 대상에서 완전히 누락됨.

---

### 🚨 원인 ③: "어느 순간부터" 발생한 이유 규명

1. 기존에는 백엔드가 별도의 탑레벨 가시 윈도우를 상시 노출하지 않았으나, **Edge Quick Widget(`UtilTools_EdgeWidget`) 기능이 병합**되면서 `pythonw.exe` 소유의 가시 윈도우가 상시 데스크톱에 상주하게 됨.
2. 이로 인해 `UtilTools_EdgeWidget`이 항상 `matched_windows`의 fallback으로 당첨되어, 터미널 대신 위젯이 포커스되는 현상이 고착화됨.

---

## 4. 단계별 조치 계획 (Action Plan)

### Step 1: 백엔드 탐색 엔진 결함 조치 ([`services/agy_service.py`](file:///D:/python/services/agy_service.py))
1. **자체 PID 배제 가드 추가**:
   - `direct_target_pids` 수집 시 현재 프로세스 PID(`os.getpid()`) 및 UtilTools 관련 프로세스는 타겟에서 원천 배제.
2. **비(非) 터미널 윈도우 매칭 차단**:
   - `is_term`이 `False`인 창은 `matched_windows`에 추가하지 않도록 엄격 필터링 (`if is_term:`).
3. **Windows Terminal & ConPTY 프로세스 트리 완벽 추적**:
   - 역추적 허용 프로세스 명단에 `'windowsterminal'`, `'openconsole'`, `'wt'` 추가.
   - ConPTY 판정 시 `'conhost'` 외에 `'openconsole'`도 감지하도록 확장.
4. **창 미발견 시 폴백 및 신규 실행 연계**:
   - 기존 터미널 창을 찾지 못했을 경우(`False`), 락이 잡혀있더라도 창이 소실된 상태라면 사용자에게 경고 후 강제 실행 옵션 제공 또는 안전한 새 터미널 구동 유도.

### Step 2: OpenCodex 서비스 동기화 ([`services/opencodex_service.py`](file:///D:/python/services/opencodex_service.py))
- `activate_opencodex_terminal_window()`에도 동일한 자체 프로세스 배제 및 Windows Terminal 역추적 로직 동기화 적용.

### Step 3: 무결성 검증 및 런타임 하이브리드 테스트
- `python scripts/verify_integrity.py` 전체 무결성 검증 통과 확인.
- 실제 Windows Terminal 및 PowerShell 창 실행 상태에서 `activate_session_terminal_window()` 호출 시 `WindowsTerminal.exe`가 정확하게 화면 최상단으로 전환되는지 런타임 검증.

---

## 5. 결론 및 향후 관리
본 결함은 Windows OS의 프로세스 상속 모델(ConPTY/Windows Terminal 1.24+) 및 앱 내 신규 윈도우(Edge Quick Widget) 도입에 따른 상호작용 간섭으로 인해 발생한 것으로, 위 계획에 따라 원천 수정하여 터미널 창 전환의 신뢰성을 확보합니다.
