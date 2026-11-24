# 🗄️ 중앙 SQLite 데이터베이스 구조 및 ERD 명세 (Database Architecture & Schema)

Util-Tools는 모든 사용자 데이터와 로컬 오프라인 캐시를 단일 중앙 SQLite 데이터베이스(`data/app.db`, 21개 사용자 정의 테이블 / `sqlite_sequence` 포함 22개 테이블)에서 통합 관리합니다.

---

## 1. ⚙️ 데이터베이스 엔진 및 성능 PRAGMA 설정

- **파일 경로**: `data/app.db` (`core.paths.DB_PATH`, Git 추적 제외)
- **커넥션 매니저**: [`services/db_service.py`](../services/db_service.py)
- **핵심 PRAGMA 최적화**:
  - `PRAGMA journal_mode=WAL;`: 동시 다중 읽기/쓰기를 지원하여 UI 멈춤 방지
  - `PRAGMA synchronous=NORMAL;`: 디스크 쓰기 I/O를 최적화하면서 크래시 안전성 보장
  - `PRAGMA busy_timeout=5000;`: 동시성 락 충돌 시 최대 5초간 자동 대기
  - `PRAGMA wal_checkpoint(TRUNCATE);`: 앱 종료 시 WAL 로그를 본 DB로 자동 병합 및 용량 최소화

---

## 2. 🏛️ 테이블 관계 및 도메인 다이어그램 (ERD)

```mermaid
erDiagram
    %% Core Productivity Tables
    EMAILS {
        text id PK
        text subject
        text clean_subject
        text thread_key
        text from_addr
        text to_addr
        text date_str
        text category
        text snippet
        text body_text
        text body_html
        text attachments_json
        text file_path
        text created_at
    }

    NOTES {
        text id PK
        text title
        text content
        text category
        text color
        integer is_pinned
        text created_at
        text updated_at
    }

    DIAGRAMS {
        text id PK
        text title
        text code
        text category
        text type
        text description
        text created_at
        text updated_at
    }

    SHORTCUTS {
        text id PK
        text title
        text key_combo
        text url_or_path
        text category
        text description
        text icon
        text created_at
    }

    QUICK_LAUNCH {
        text id PK
        text title
        text path
        text icon
        text category
        text description
        integer order_index
        text created_at
    }

    GENERATORS {
        text id PK
        text title
        text language
        text template
        text description
        text category
        text icon
        text variables_json
        text created_at
    }

    MOCK_TEMPLATES {
        text id PK
        text title
        text description
        text icon
        text schema_json
        text created_at
        text updated_at
    }

    AI_EMBEDDINGS {
        text key PK
        text hash
        blob vector
        text updated_at
    }

    %% Redmine Local Cache Domain
    REDMINE_CONFIG {
        text id PK
        text server_url
        text api_key
        integer user_id
        text user_name
        integer auto_sync
        integer sync_interval_min
        text sync_scope
        integer sync_limit
    }

    REDMINE_ISSUES {
        integer id PK
        integer project_id
        text project_name
        text tracker_name
        text status_name
        text priority_name
        text assigned_to_name
        text subject
        text description
        text start_date
        text due_date
        integer done_ratio
        integer is_my_issue
        text updated_on
    }

    REDMINE_WIKIS {
        text id PK
        text project_id
        text title
        integer version
        text text
        text updated_on
    }

    REDMINE_PROJECTS {
        integer id PK
        text name
        text identifier
        text description
        integer status
        integer is_favorite
        integer favorite_order
    }

    REDMINE_CONFIG ||--o{ REDMINE_ISSUES : caches
    REDMINE_PROJECTS ||--o{ REDMINE_ISSUES : contains
    REDMINE_PROJECTS ||--o{ REDMINE_WIKIS : contains

    %% Speech & OCR Studio Tables
    AUDIO_FILES {
        integer id PK
        text file_path
        text filename
        integer file_size
        real duration_sec
        text created_at
    }

    TRANSCRIPTION_RUNS {
        integer id PK
        integer audio_id FK
        text model_name
        text language
        text stt_device
        integer enable_diarization
        text diarization_provider
        integer num_speakers
        real cluster_threshold
        text status
        real progress
        text current_phase
        real rtf
        real eta_sec
        text segments_json
        text speaker_names_json
        text error_message
        text created_at
        text updated_at
    }

    OCR_HISTORY {
        integer id PK
        text source_type
        text filename
        integer image_width
        integer image_height
        text extracted_text
        text blocks_json
        text thumbnail_path
        real latency_ms
        text created_at
    }

    AUDIO_FILES ||--o{ TRANSCRIPTION_RUNS : executes

    %% Extended Productivity & Sync Tables
    CALENDAR_REMINDERS {
        text event_uid PK
        text calendar_name
        text title
        text start_datetime
        integer reminder_minutes
        integer is_enabled
        integer is_notified
        text created_at
        text updated_at
    }

    NOTE_CATEGORIES {
        text id PK
        text name
        text icon
        integer sort_order
        integer is_system
        text created_at
        text updated_at
    }

    QR_HISTORY {
        integer id PK
        text action_type
        text content
        text title
        text format_type
        text created_at
    }

    CALENDAR_EVENTS_CACHE {
        text calendar_id PK
        text calendar_name
        text calendar_url
        text events_json
        text updated_at
    }

    IMAP_ACCOUNTS {
        integer id PK
        text account_name
        text host
        integer port
        integer use_ssl
        text username
        text auth_type
        text folder
        integer poll_interval_minutes
        text last_sync_at
        text created_at
        text updated_at
    }

    NOTE_CATEGORIES ||--o{ NOTES : classifies
    IMAP_ACCOUNTS ||--o{ EMAILS : archives
```

---

## 3. 📋 21개 사용자 테이블별 상세 스키마 명세 (Schema Specifications)

### ① `emails` (대용량 이메일 아카이브)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 이메일 고유 해시 식별자 |
| `subject` | `TEXT` | - | 원본 이메일 제목 |
| `clean_subject` | `TEXT` | - | Re:/Fwd: 접두사가 제거된 정규화된 스레드 제목 |
| `thread_key` | `TEXT` | - | 대화 스레드 그룹핑 키 (인덱스 생성) |
| `from_addr` | `TEXT` | - | 발신자 이름 및 이메일 주소 |
| `to_addr` | `TEXT` | - | 수신자 목록 |
| `date_str` | `TEXT` | - | 작성 일시 (RFC2822 / ISO8601) |
| `category` | `TEXT` | `'기타'` | 6대 자동 분류 카테고리 (인덱스 생성) |
| `snippet` | `TEXT` | - | 본문 150자 미리보기 요약문 |
| `body_text` | `TEXT` | - | 일반 텍스트 본문 |
| `body_html` | `TEXT` | - | HTML 서식 본문 |
| `attachments_json`| `TEXT` | `'[]'` | 첨부파일 메타데이터 JSON 배열 |
| `message_id` | `TEXT` | - | 이메일 헤더 `Message-ID` |
| `in_reply_to` | `TEXT` | - | 회신 대상 `In-Reply-To` 헤더 |
| `references_header`| `TEXT`| - | 참조 체인 `References` 헤더 |
| `file_path` | `TEXT` | - | 로컬 `emails/*.eml` 물리 파일 경로 |
| `created_at` | `TEXT` | - | DB 등록 일시 |

> **인덱스**: `idx_emails_category`, `idx_emails_thread_key`, `idx_emails_date`, `idx_emails_created_at`, `idx_emails_sort (created_at DESC, date_str DESC)`

---

### ② `notes` (빠른 메모 / 스크래치패드)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 메모 고유 식별자 |
| `title` | `TEXT` | - | 메모 제목 |
| `content` | `TEXT` | - | 메모 내용 (텍스트/마크다운) |
| `category` | `TEXT` | `''` | 카테고리 태그 |
| `color` | `TEXT` | `''` | 메모 카드 테마 색상 코드 |
| `is_pinned` | `INTEGER` | `0` | 상단 고정 여부 (1: 고정, 0: 일반) |
| `created_at` | `TEXT` | - | 생성 일시 |
| `updated_at` | `TEXT` | - | 최종 수정 일시 (자동 갱신) |

> **인덱스**: `idx_notes_pinned`, `idx_notes_updated_at`, `idx_notes_created_at`, `idx_notes_sort (is_pinned DESC, updated_at DESC, created_at DESC)`

---

### ③ `diagrams` (Mermaid 다이어그램)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 다이어그램 고유 식별자 |
| `title` | `TEXT` | - | 다이어그램 제목 |
| `code` | `TEXT` | - | Mermaid 다이어그램 소스 코드 |
| `category` | `TEXT` | - | 분류 카테고리 |
| `type` | `TEXT` | `''` | 다이어그램 종류 (flowchart, sequence, mindmap 등) |
| `description` | `TEXT` | - | 상세 설명 |
| `created_at` | `TEXT` | - | 생성 일시 |
| `updated_at` | `TEXT` | - | 수정 일시 |

> **인덱스**: `idx_diagrams_category`, `idx_diagrams_updated_at`

---

### ④ `shortcuts` (폴더 바로가기)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 바로가기 ID |
| `title` | `TEXT` | - | 표시 명칭 |
| `key_combo` | `TEXT` | `''` | 단축키 조합 (선택 사항) |
| `url_or_path` | `TEXT` | - | 대상 폴더 경로 또는 URL |
| `category` | `TEXT` | `'folder'` | 카테고리 |
| `description` | `TEXT` | `''` | 툴팁 설명문 |
| `icon` | `TEXT` | `'📁'` | 이모지/아이콘 |
| `created_at` | `TEXT` | - | 생성 일시 |

> **인덱스**: `idx_shortcuts_category`

---

### ⑤ `quick_launch` (빠른 실행)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 빠른 실행 ID |
| `title` | `TEXT` | - | 실행 항목 이름 |
| `path` | `TEXT` | - | 실행 파일 경로, URL, 또는 CLI 명령어 |
| `icon` | `TEXT` | `'⚡'` | 표시 아이콘 |
| `category` | `TEXT` | `'cmd'` | 실행 타입 (`cmd`, `exe`, `url`, `ssh`) |
| `description` | `TEXT` | `''` | 설명 |
| `order_index` | `INTEGER` | `0` | 드래그 앤 드롭 정렬 순서 인덱스 |
| `created_at` | `TEXT` | - | 생성 일시 |

> **인덱스**: `idx_quick_launch_order`

---

### ⑥ `generators` (커스텀 데이터 생성기)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 생성기 ID |
| `title` | `TEXT` | - | 생성기 이름 |
| `language` | `TEXT` | `'javascript'` | 스크립트 엔진 |
| `template` | `TEXT` | - | 실행 JavaScript 코드 본문 |
| `description` | `TEXT` | - | 생성기 설명 |
| `category` | `TEXT` | - | 카테고리 |
| `icon` | `TEXT` | `'🔢'` | 아이콘 |
| `variables_json`| `TEXT` | `'[]'` | 사용자 입력 파라미터 정의 JSON |
| `created_at` | `TEXT` | - | 생성 일시 |

> **인덱스**: `idx_generators_category`

---

### ⑦ `mock_templates` (모의 데이터 서식 양식)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 양식 ID |
| `title` | `TEXT` | `NOT NULL` | 양식 이름 (예: 회원 목록 양식) |
| `description` | `TEXT` | `''` | 양식 설명 |
| `icon` | `TEXT` | `'📋'` | 아이콘 |
| `schema_json` | `TEXT` | `NOT NULL` | 컬럼 정의(컬럼명, 데이터타입, 생성규칙) JSON |
| `created_at` | `TEXT` | - | 생성 일시 |
| `updated_at` | `TEXT` | - | 수정 일시 |

> **인덱스**: `idx_mock_templates_updated`

---

### ⑧ `ai_embeddings` (AI 시맨틱 임베딩 벡터 캐시)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `key` | `TEXT` | `PRIMARY KEY` | 데이터 고유 식별 키 (예: `emails:em_102`) |
| `hash` | `TEXT` | `NOT NULL` | 텍스트 변경 감지용 MD5/SHA256 해시 |
| `vector` | `BLOB` | `NOT NULL` | 384차원 float32 임베딩 바이너리 배열 |
| `updated_at` | `TEXT` | - | 임베딩 생성/갱신 일시 |

> **인덱스**: `idx_ai_embeddings_hash`

---

### ⑨ `redmine_config` (Redmine 연결 및 동기화 설정)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 설정 프로필 ID (`'default'`) |
| `server_url` | `TEXT` | - | Redmine 서버 URL (`https://...`) |
| `api_key` | `TEXT` | - | 사용자 REST API 접근 키 |
| `user_id` | `INTEGER` | - | 로그인된 Redmine 사용자 ID |
| `user_name` | `TEXT` | - | 사용자 실명 |
| `user_login` | `TEXT` | - | 사용자 로그인 계정명 |
| `auto_sync` | `INTEGER` | `1` | 백그라운드 자동 동기화 활성화 여부 |
| `sync_interval_min`| `INTEGER`| `5` | 동기화 주기 (분 단위) |
| `sync_scope` | `TEXT` | `'all_open'` | 동기화 범위 (`my_issues`, `all_open`, `project`) |
| `sync_limit` | `INTEGER` | `300` | 일괄 동기화 최대 일감 수 |
| `sync_project_id` | `INTEGER`| `0` | 특정 프로젝트 ID 지정 동기화 시 사용 |
| `updated_at` | `TEXT` | - | 설정 수정 일시 |

---

### ⑩ `redmine_issues` (Redmine 일감 로컬 오프라인 캐시)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `INTEGER` | `PRIMARY KEY` | Redmine 일감 번호 (#Issue ID) |
| `project_id` | `INTEGER` | - | 소속 프로젝트 ID |
| `project_name` | `TEXT` | - | 소속 프로젝트 명칭 |
| `tracker_name` | `TEXT` | - | 트래커 (결함, 기능, 지원 등) |
| `status_name` | `TEXT` | - | 상태 (신규, 진행, 해결, 완료 등) |
| `priority_name`| `TEXT` | - | 우선순위 (낮음, 보통, 높음, 긴급 등) |
| `author_name` | `TEXT` | - | 등록자 이름 |
| `assigned_to_name`| `TEXT` | - | 담당자 이름 |
| `subject` | `TEXT` | - | 일감 제목 |
| `description` | `TEXT` | - | 일감 설명 본문 |
| `start_date` | `TEXT` | - | 시작일 |
| `due_date` | `TEXT` | - | 완료 기한일 |
| `done_ratio` | `INTEGER` | `0` | 진척도 (0 ~ 100%) |
| `estimated_hours`| `REAL` | - | 추정 시간 |
| `updated_on` | `TEXT` | - | Redmine 서버 기준 최종 수정 일시 |
| `created_on` | `TEXT` | - | 등록 일시 |
| `is_my_issue` | `INTEGER` | `0` | 내 담당 일감 여부 플래그 (1: 내 일감) |
| `raw_json` | `TEXT` | - | Redmine API 원본 전체 응답 JSON |

> **인덱스**: `idx_redmine_issues_project`, `idx_redmine_issues_status`, `idx_redmine_issues_assigned`, `idx_redmine_issues_my`, `idx_redmine_issues_due`, `idx_redmine_issues_updated`, `idx_redmine_issues_sort (updated_on DESC, id DESC)`

---

### ⑪ `redmine_wikis` (Redmine 프로젝트 위키 문서 캐시)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 위키 복합 키 (`{project_id}:{title}`) |
| `project_id` | `TEXT` | - | 프로젝트 식별자 |
| `project_name` | `TEXT` | - | 프로젝트 명칭 |
| `title` | `TEXT` | - | 위키 페이지 제목 |
| `version` | `INTEGER` | `1` | 위키 문서 버전 |
| `author_name` | `TEXT` | - | 작성자 |
| `comments` | `TEXT` | - | 버전 코멘트 |
| `text` | `TEXT` | - | 위키 본문 (Textile / Markdown) |
| `updated_on` | `TEXT` | - | 최종 수정 일시 |
| `created_on` | `TEXT` | - | 최초 작성 일시 |

> **인덱스**: `idx_redmine_wikis_project`, `idx_redmine_wikis_title`

---

### ⑫ `redmine_projects` (프로젝트 목록 및 즐겨찾기 캐시)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `INTEGER` | `PRIMARY KEY` | 프로젝트 ID |
| `name` | `TEXT` | - | 프로젝트 이름 |
| `identifier` | `TEXT` | - | 프로젝트 영문 식별자 |
| `description` | `TEXT` | - | 프로젝트 설명 |
| `status` | `INTEGER` | `1` | 상태 (1: 활성) |
| `is_favorite` | `INTEGER` | `0` | 주요 관심 프로젝트 여부 (1: 즐겨찾기) |
| `favorite_order`| `INTEGER`| `0` | 즐겨찾기 정렬 순서 |

> **인덱스**: `idx_redmine_projects_fav (is_favorite, favorite_order)`

---

### ⑬ `redmine_meta` (트래커, 상태, 우선순위 메타데이터 캐시)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `key` | `TEXT` | `PRIMARY KEY` | 메타데이터 키 (`'statuses'`, `'trackers'`, `'priorities'`) |
| `data_json` | `TEXT` | - | 메타데이터 JSON 배열 |
| `updated_at` | `TEXT` | - | 최종 갱신 일시 |

---

### ⑭ `audio_files` (오디오 원본 파일 라이브러리)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | 오디오 고유 식별자 |
| `file_path` | `TEXT` | `NOT NULL UNIQUE` | 로컬 디스크 절대 경로 (`data/audio/`) |
| `filename` | `TEXT` | `NOT NULL` | 표시용 파일명 |
| `file_size` | `INTEGER` | `NOT NULL` | 파일 크기 (Bytes) |
| `duration_sec` | `REAL` | `0.0` | PyAV 산출 오디오 재생 시간 (초) |
| `created_at` | `TEXT` | `datetime('now', 'localtime')` | 등록 일시 |

> **인덱스**: `idx_audio_files_created (created_at DESC)`

---

### ⑮ `transcription_runs` (음성 전사 및 화자 분리 실행 이력)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | 실행 런 고유 식별자 |
| `audio_id` | `INTEGER` | `NOT NULL, FK(audio_files.id)` | 대상 오디오 ID (ON DELETE CASCADE) |
| `model_name` | `TEXT` | `'small'` | Whisper 모델 크기 (`'tiny'`, `'small'`, `'medium'`, `'large-v3'`) |
| `language` | `TEXT` | `'ko'` | 대상 언어 코드 (`'ko'`, `'en'`, `'auto'`) |
| `stt_device` | `TEXT` | `'cuda'` | 실행 디바이스 (`'cuda'`, `'cpu'`) |
| `enable_diarization` | `INTEGER` | `0` | 화자 분리 활성화 여부 (1: ON, 0: OFF) |
| `diarization_provider` | `TEXT` | `'cpu'` | 화자 분리 연산 프로바이더 |
| `num_speakers` | `INTEGER` | `0` | 화자 수 (0: 자동 감지) |
| `cluster_threshold` | `REAL` | `0.5` | 군집화 임계값 |
| `status` | `TEXT` | `'PENDING'` | 작업 상태 (`'PENDING'`, `'TRANSCRIBING'`, `'DIARIZING'`, `'ALIGNING'`, `'COMPLETED'`, `'FAILED'`, `'CANCELLED'`) |
| `progress` | `REAL` | `0.0` | 0.0 ~ 100.0% 진행률 |
| `current_phase` | `TEXT` | `'PENDING'` | 현재 단계 (`'STT'`, `'DIARIZATION'`, `'ALIGNMENT'`, `'FINISHED'`, `'ERROR'`) |
| `rtf` | `REAL` | `0.0` | 실측 실시간 팩터 (Real-Time Factor) |
| `eta_sec` | `REAL` | `0.0` | 예상 잔여 시간 (초) |
| `segments_json` | `TEXT` | `'[]'` | 정합 완료된 표준 세그먼트 JSON 배열 |
| `speaker_names_json` | `TEXT` | `'{}'` | 화자 이름 매핑 JSON 객체 |
| `error_message` | `TEXT` | `''` | 실패 시 오류 메시지 |
| `created_at` | `TEXT` | `datetime('now', 'localtime')` | 작업 요청 일시 |
| `updated_at` | `TEXT` | `datetime('now', 'localtime')` | 상태 최종 변경 일시 |

> **인덱스**: `idx_runs_audio (audio_id)`, `idx_runs_status (status)`, `idx_runs_updated (updated_at DESC)`

---

### ⑯ `ocr_history` (Windows Media OCR 텍스트 추출 이력)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | OCR 이력 고유 식별자 |
| `source_type` | `TEXT` | `NOT NULL` | 소스 유형 (`'clipboard'`, `'file'`, `'screenshot'`) |
| `filename` | `TEXT` | `''` | 원본 파일명 (파일 입력 시) |
| `image_width` | `INTEGER` | `0` | 입력 이미지 가로 해상도 (px) |
| `image_height` | `INTEGER` | `0` | 입력 이미지 세로 해상도 (px) |
| `extracted_text` | `TEXT` | `NOT NULL` | 추출된 전체 텍스트 |
| `blocks_json` | `TEXT` | `'[]'` | 텍스트 라인/단어별 좌표 및 신뢰도 JSON |
| `thumbnail_path` | `TEXT` | `''` | 썸네일 이미지 저장 경로 |
| `latency_ms` | `REAL` | `0.0` | OCR 추론 소요 시간 (밀리초) |
| `created_at` | `TEXT` | `datetime('now', 'localtime')` | 인식 일시 |

> **인덱스**: `idx_ocr_history_created (created_at DESC)`

---

### ⑰ `calendar_reminders` (캘린더 개별 일정 알림)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `event_uid` | `TEXT` | `PRIMARY KEY` | 일정 고유 식별자 (`UID`) |
| `calendar_name` | `TEXT` | `''` | 소속 캘린더 명칭 |
| `title` | `TEXT` | `NOT NULL` | 일정 제목 |
| `start_datetime` | `TEXT` | `NOT NULL` | 일정 시작 일시 (`YYYY-MM-DD HH:MM`) |
| `reminder_minutes` | `INTEGER` | `10` | 시작 몇 분 전 알림 여부 (분) |
| `is_enabled` | `INTEGER` | `1` | 알림 활성화 여부 (1: 활성, 0: 비활성) |
| `is_notified` | `INTEGER` | `0` | 알림 발송 완료 플래그 (중복 발송 방지) |
| `created_at` | `TEXT` | `datetime('now', 'localtime')` | 생성 일시 |
| `updated_at` | `TEXT` | `datetime('now', 'localtime')` | 수정 일시 |

> **인덱스**: `idx_calendar_reminders_active (is_enabled, is_notified, start_datetime)`

---

### ⑱ `note_categories` (빠른 메모 보관함/카테고리)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | 카테고리 식별자 (기본 시딩: `all`, `scratch`, `work`, `personal`) |
| `name` | `TEXT` | `NOT NULL` | 표시 카테고리 명칭 |
| `icon` | `TEXT` | `'📁'` | 카테고리 이모지 아이콘 |
| `sort_order` | `INTEGER` | `0` | 정렬 순서 |
| `is_system` | `INTEGER` | `0` | 시스템 기본 카테고리 여부 (1: 삭제 불가) |
| `created_at` | `TEXT` | `datetime('now', 'localtime')` | 생성 일시 |
| `updated_at` | `TEXT` | `datetime('now', 'localtime')` | 수정 일시 |

> **인덱스**: `idx_note_categories_order (sort_order ASC)`

---

### ⑲ `qr_history` (QR 코드 스캔 및 생성 이력)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | 이력 고유 식별자 |
| `action_type` | `TEXT` | `NOT NULL` | 작업 구분 (`'scan'`, `'generate'`) |
| `content` | `TEXT` | `NOT NULL` | QR 코드 원문 데이터 |
| `title` | `TEXT` | `''` | 사용자 지정 메모/제목 |
| `format_type` | `TEXT` | `'text'` | 자동 판별된 포맷 (`'url'`, `'wifi'`, `'email'`, `'tel'`, `'vcard'`, `'text'`) |
| `created_at` | `TEXT` | `datetime('now', 'localtime')` | 기록 일시 |

> **인덱스**: `idx_qr_history_created (created_at DESC)`

---

### ⑳ `calendar_events_cache` (캘린더 구독별 일정 스냅샷 로컬 캐시)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `calendar_id` | `TEXT` | `PRIMARY KEY` | 캘린더 구독 식별자 |
| `calendar_name` | `TEXT` | `''` | 캘린더 표시 이름 |
| `calendar_url` | `TEXT` | `''` | 정규화된 ICS 구독 URL |
| `events_json` | `TEXT` | `'[]'` | 파싱된 일정 이벤트 JSON 배열 (선 캐시 렌더링용) |
| `updated_at` | `TEXT` | `datetime('now', 'localtime')` | 최종 캐시 갱신 일시 |

---

### ㉑ `imap_accounts` (IMAP 계정 설정 및 OAuth 2.0 동기화 상태)
| 컬럼명 | 데이터 타입 | 기본값 / 제약조건 | 설명 |
| :--- | :--- | :--- | :--- |
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | IMAP 계정 고유 식별자 |
| `account_name` | `TEXT` | `NOT NULL` | 표시용 계정 별칭 |
| `host` | `TEXT` | `NOT NULL` | IMAP 서버 호스트명 (예: `imap.gmail.com`) |
| `port` | `INTEGER` | `993` | IMAP 포트 번호 |
| `use_ssl` | `INTEGER` | `1` | SSL/TLS 사용 여부 (1: IMAP4_SSL) |
| `username` | `TEXT` | `NOT NULL` | 로그인 계정(이메일 주소) |
| `password` | `TEXT` | `''` | 일반/앱 비밀번호 (`password` 인증 시) |
| `auth_type` | `TEXT` | `'password'` | 인증 방식 (`'password'`, `'oauth2_google'`) |
| `oauth_client_id` | `TEXT` | `''` | Google OAuth 2.0 Client ID |
| `oauth_client_secret` | `TEXT` | `''` | Google OAuth 2.0 Client Secret |
| `oauth_refresh_token` | `TEXT` | `''` | Google OAuth 2.0 Refresh Token |
| `oauth_access_token` | `TEXT` | `''` | 발급된 Access Token 캐시 |
| `oauth_token_expiry` | `INTEGER` | `0` | Access Token 만료 Epoch 타임스탬프 (초) |
| `folder` | `TEXT` | `'INBOX'` | 동기화 대상 사서함 폴더명 |
| `poll_interval_minutes` | `INTEGER` | `0` | 백그라운드 자동 폴링 주기 (분, 0: 수동 전용) |
| `last_sync_at` | `TEXT` | `NULL` | 마지막 동기화 완료 일시 |
| `created_at` | `TEXT` | `datetime('now', 'localtime')` | 등록 일시 |
| `updated_at` | `TEXT` | `datetime('now', 'localtime')` | 수정 일시 |

> **참고**: `AUTOINCREMENT` 테이블이 존재하므로 SQLite 내부 메타 테이블 `sqlite_sequence`를 포함해 `sqlite_master`에는 총 22개 테이블이 생성됩니다.

---

## 4. 📁 파일 기반 설정 파일 (File-based JSON Configurations)

데이터베이스 외에 다음 설정 파일들은 독립된 JSON 파일로 관리되어 외부 연동 및 설정을 지원합니다:
- **`calendar_config.json`**: 구글 캘린더 비공개 주소 및 iCal(ICS) 웹 구독 목록, 자동 갱신 주기
- **`app_settings.json`**: 윈도우 창 크기, 콘솔 높이, 분할창 크기 등 사용자 인터페이스 영구 설정
- **`data/widget_config.json`**: 엣지 핸들 위치(`edge`, `offset_ratio`), 핸들 크기(`handle_size`), 대상 모니터(`device_name`) 영속 설정
- **`data/stock_config.json`**: Toss Open API 자격증명(`client_id`, `client_secret`), 연결 모드(`connection_mode`: `local` / `relay`), 개인 Relay 서버 접속 정보(`relay_url`, `relay_token`), 커스텀 그룹별 관심종목(`groups`, `active_group_id`, `watchlist`) 및 환율 캐시(`fx_cache`)
- **`data/stock_master.json`**: Toss Open API에서 동기화한 국내/미국 상장 종목 유니버스 검색 캐시

