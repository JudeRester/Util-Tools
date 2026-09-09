---
name: gitflow-branching-strategy
description: main 브랜치 직접 변경 금지 및 GitFlow 기반 브랜치 생성/전환 작업 규정
trigger: always_on
---

# 🌿 GitFlow 브랜치 전략 및 main 브랜치 보호 규정 (GitFlow & Branch Protection Rule)

본 프로젝트(Util-Tools)의 모든 개발, 리팩토링, 버그 수정 및 설정 변경 작업은 코드베이스의 안정성과 릴리스 이력의 무결성을 유지하기 위해 반드시 아래의 **GitFlow 브랜치 전략**을 준수해야 합니다.

---

## 1. 🚨 main 브랜치 직접 변경 절대 금지 (Protected main Branch Rule)

1. **main 브랜치의 성격**:
   - `main` 브랜치는 언제든 프로덕션 환경에 배포 가능한(production-ready) 안정 상태를 유지하는 핵심 브랜치입니다.
2. **엄격한 변경 금지 원칙**:
   - **`main` 브랜치에서의 직접적인 파일 수정, 코드 편집, 직접 커밋(`git commit`), 직접 푸시(`git push`)를 전면 금지**합니다.
   - 모든 변경 사항은 반드시 목적에 맞게 분기된 작업 브랜치에서 이루어져야 합니다.
3. **작업 착수 전 브랜치 검증 의무화 (Pre-work Branch Verification)**:
   - 작업 착수 전 반드시 현재 체크아웃된 브랜치를 확인해야 합니다:
     ```powershell
     git branch --show-current
     ```
   - 현재 브랜치가 `main`인 경우, 코드를 수정하기 전에 **반드시 적합한 작업 브랜치를 생성하고 해당 브랜치로 전환(`switch` / `checkout`)**해야 합니다.

---

## 2. 🌲 GitFlow 브랜치 구조 및 정의 (Branch Architecture)

GitFlow 모델에 따라 브랜치를 **영구 브랜치(Primary Branches)**와 **임시 작업 브랜치(Supporting Branches)**로 명확히 구분하여 운용합니다:

```
[main] ─────────────────────●──────────────● (v1.0.1 Hotfix) ──────● (v1.1.0 Release)
         \                 / \            /                        /
[hotfix]  \               /   └───●──────┘                        /
           \             /       (hotfix/crash-fix)              /
[release]   \           /                                ┌──●───┘
             \         /                                /  (release/v1.1.0)
[develop]     ●───────●────────────────●───────────────●───────────●
               \     /                  \             /
[feature]       └───●────────────────────●───────────┘
                  (feature/email-backup)   (feature/search-engine)
```

### 1) 영구 브랜치 (Primary Branches)
* **`main`**:
  - 최종 릴리스된 완성본 코드만 존재합니다.
  - 직접 커밋이 불가하며, 오직 검증된 `release` 또는 `hotfix` 브랜치의 병합(Merge)을 통해서만 변경됩니다.
  - 병합 완료 시 버전 태그(예: `v1.0.0`)를 부착합니다.
* **`develop`**:
  - 차기 배포를 위한 개발 작업이 통합되는 중심 개발 브랜치입니다.
  - 모든 기능 구현(Feature)과 일상 버그 수정(Bugfix)이 최종 병합되는 기준 브랜치입니다.

### 2) 보조/작업 브랜치 (Supporting Branches)

| 브랜치 유형 | 분기 시작 기준 (Branch From) | 병합 대상 (Merge Into) | 명명 규칙 (Naming Convention) | 주요 목적 및 설명 |
| :--- | :--- | :--- | :--- | :--- |
| **`feature/*`** | `develop` | `develop` | `feature/<기능명-또는-이슈키>`<br>예: `feature/calendar-recurrence`, `feature/sqlite-vacuum` | 신규 기능 개발, 성능 개선, 대규모 리팩토링 |
| **`bugfix/*`** | `develop` | `develop` | `bugfix/<결함명-또는-이슈키>`<br>예: `bugfix/tray-icon-blink` | 개발 과정(`develop`)에서 발견된 일반 결함 조치 |
| **`release/*`** | `develop` | `main` 및 `develop` | `release/v<x.y.z>`<br>예: `release/v1.1.0` | 새로운 프로덕션 릴리스 준비, 최종 검수, 버전 번호 갱신 |
| **`hotfix/*`** | `main` | `main` 및 `develop` | `hotfix/v<x.y.z+1>` 또는 `hotfix/<이슈명>`<br>예: `hotfix/v1.0.1`, `hotfix/app-crash` | 이미 배포된 `main`에서 발생한 긴급 운영 결함 즉시 조치 |

---

## 3. 🔄 단계별 표준 작업 수명주기 (Workflow Lifecycle)

모든 작업은 아래의 5단계 절차를 철저히 준수하여 순차적으로 진행합니다:

### 1단계: 기준 브랜치 최신화 및 상태 점검
```powershell
# 1. 미저장 작업 내역 유무 확인
git status

# 2. 기준 브랜치(develop 또는 main)로 이동 후 원격 최신 커밋 동기화
git switch develop
git pull origin develop
```

### 2단계: GitFlow 작업 브랜치 생성 및 전환
목적에 맞는 접두사를 사용하여 새 브랜치를 생성하고 즉시 해당 브랜치로 전환합니다:
```powershell
# 신규 기능 또는 개선 작업 시
git switch -c feature/<작업명>
# 또는 구버전 git 호환 명령어:
# git checkout -b feature/<작업명>

# 운영 긴급 패치 작업 시 (main에서 분기)
git switch main
git pull origin main
git switch -c hotfix/<패치명>
```

### 3단계: 작업 수행 및 무결성 검증
생성된 작업 브랜치 내에서만 코드를 작성/수정하고, 작업 완료 전 무결성 검사를 수행합니다:
```powershell
# 코드 작성/수정 완료 후 원스톱 무결성 검증 통과 필수
python scripts/verify_integrity.py
```

### 4단계: 변경 사항 스테이징 및 규격 커밋
검증이 완료되면 명확하고 객관적인 엔지니어링 용어로 커밋 메시지를 작성합니다:
```powershell
git status --short
git add <수정된_파일들>
git commit -m "feat(calendar): 반복 일정 동기화 로직 구현"
```
*(과장된 마케팅성 표현 금지: `code_integrity.md` 제4원칙 준수)*

### 5단계: 기준 브랜치 병합 및 작업 브랜치 정리
작업이 완료되고 검증을 마친 후 기준 브랜치로 안전하게 통합합니다:
```powershell
# develop 브랜치로 이동 및 최신화
git switch develop
git pull origin develop

# feature 브랜치 병합 (기록 보존을 위해 --no-ff 권장)
git merge --no-ff feature/<작업명>

# 병합 완료된 임시 브랜치 삭제
git branch -d feature/<작업명>
```

---

## 4. 🛡️ 안전 가드 및 긴급 복구 프로토콜 (Safety Guards & Recovery)

### 상황: 실수로 `main` 브랜치에서 파일을 수정한 경우 (커밋 전)
아직 커밋하지 않은 파일 변경 사항이 `main` 브랜치에 남아있을 때, 이를 안전하게 작업 브랜치로 이전하는 절차입니다:

```powershell
# 방법 1: 변경 사항을 유지한 채 새 브랜치 생성 및 이동 (가장 신속)
git switch -c feature/<작업명>
# 이 명령을 실행하면 수정된 파일들이 그대로 feature 브랜치로 이전됩니다.

# 방법 2: stash를 활용한 안전 분기
git stash save "main 브랜치 임시 작업분"
git switch develop
git switch -c feature/<작업명>
git stash pop
```

### 상황: 실수로 `main` 브랜치에 로컬 커밋을 생성한 경우 (푸시 전)
```powershell
# 1. 현재 커밋 내용을 담아 신규 브랜치 생성
git branch feature/<작업명>

# 2. main 브랜치를 이전 커밋으로 되돌림 (HEAD~1)
git reset --hard HEAD~1

# 3. 작업 브랜치로 전환하여 작업 지속
git switch feature/<작업명>
```

---

## 5. 📋 요약 체크리스트 (Summary Checklist)

* [ ] 작업 전 현재 브랜치가 `main`이 아닌지 확인했는가? (`git branch --show-current`)
* [ ] 작업 목적에 부합하는 접두사(`feature/`, `bugfix/`, `hotfix/`, `release/`)를 사용하여 브랜치를 생성하고 이동했는가?
* [ ] 코드 수정 후 `python scripts/verify_integrity.py`를 실행하여 무결성을 검증했는가?
* [ ] 커밋 메시지는 객관적이고 직관적인 엔지니어링 사실을 기반으로 작성했는가?
* [ ] 작업 완료 후 해당 브랜치를 적절한 타깃(`develop` 또는 `main`)으로 병합 또는 PR을 진행했는가?
