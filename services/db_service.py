"""
중앙 SQLite 데이터베이스 관리자 및 커넥션 풀 매니저
- 데이터베이스 파일: data/app.db
- WAL 모드 및 고성능/충돌방지 PRAGMA 설정
- emails, notes, diagrams, quick_launch, shortcuts, generators 테이블 및 인덱스 관리
- 기존 JSON 파일들로부터 최초 1회 자동 마이그레이션 지원
"""
import os
import json
import sqlite3
import re
import time
import datetime
import threading

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(base_dir, "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")

# 각 모듈별 JSON 파일 경로 (마이그레이션 및 폴백용)
EMAILS_JSON_PATH = os.path.join(base_dir, "emails.json")
EMAILS_EXAMPLE_PATH = os.path.join(base_dir, "emails.example.json")

NOTES_JSON_PATH = os.path.join(base_dir, "notes.json")
NOTES_EXAMPLE_PATH = os.path.join(base_dir, "notes.example.json")

DIAGRAMS_JSON_PATH = os.path.join(base_dir, "diagrams.json")
DIAGRAMS_EXAMPLE_PATH = os.path.join(base_dir, "diagrams.example.json")

QUICK_LAUNCH_JSON_PATH = os.path.join(base_dir, "quick_launch.json")
QUICK_LAUNCH_EXAMPLE_PATH = os.path.join(base_dir, "quick_launch.example.json")

SHORTCUTS_JSON_PATH = os.path.join(base_dir, "shortcuts.json")
SHORTCUTS_EXAMPLE_PATH = os.path.join(base_dir, "shortcuts.example.json")

GENERATORS_JSON_PATH = os.path.join(base_dir, "generators.json")
GENERATORS_EXAMPLE_PATH = os.path.join(base_dir, "generators.example.json")

_init_lock = threading.Lock()
_is_initialized = False


def _ensure_data_dir():
    """data 폴더가 없으면 자동 생성"""
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR, exist_ok=True)


def clean_subject(subject):
    """이메일 제목에서 회신/전달/상태 접두사를 제거하고 정규화된 스레드 제목 반환"""
    if not subject:
        return "(제목 없음)"
    
    s = str(subject).strip()
    prefix_pattern = re.compile(
        r'^(?:'
        r'(?:re|fwd?|fw|답장|전달)(?:\[\d+\]|\(\d+\))?\s*[:：\-]\s*'
        r'|\[(?:re|fwd?|fw|회수|공유|답장|전달|참고|재전달)\]\s*'
        r'|\((?:re|fwd?|fw|회수|공유|답장|전달|참고|재전달|remind|추가설명)\)\s*'
        r'|(?:회수|공유|답장|전달|재전달)\s*[:：\-]\s*'
        r')+',
        re.IGNORECASE
    )
    
    prev = None
    while prev != s:
        prev = s
        s = prefix_pattern.sub('', s).strip()
        
    s = re.sub(r'\s+', ' ', s).strip()
    return s if s else "(제목 없음)"


def get_db_connection():
    """
    고성능 & 충돌 방지 설정이 적용된 SQLite 데이터베이스 커넥션 반환
    - PRAGMA journal_mode=WAL (동시 읽기/쓰기 지원)
    - PRAGMA synchronous=NORMAL (디스크 I/O 최적화 및 크래시 안전)
    - PRAGMA busy_timeout=5000 (동시성 락 대기 5초)
    """
    _ensure_data_dir()
    conn = sqlite3.connect(DB_PATH, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def _safe_log(msg):
    try:
        print(msg, flush=True)
    except Exception:
        try:
            safe_msg = msg.encode('ascii', errors='replace').decode('ascii')
            print(safe_msg, flush=True)
        except Exception:
            pass


def _migrate_emails_from_json_if_needed(conn):
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM emails")
    count = cursor.fetchone()[0]
    if count > 0:
        return

    json_path = None
    if os.path.exists(EMAILS_JSON_PATH):
        json_path = EMAILS_JSON_PATH
    elif os.path.exists(EMAILS_EXAMPLE_PATH):
        json_path = EMAILS_EXAMPLE_PATH

    if not json_path:
        return

    _safe_log(f"[SQLite Migration] {os.path.basename(json_path)}에서 emails 테이블로 데이터 이전 중...")
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            emails_data = json.load(f)

        if not isinstance(emails_data, list) or len(emails_data) == 0:
            return

        records = []
        for em in emails_data:
            em_id = em.get("id", "")
            if not em_id:
                continue
            subject = em.get("subject", "(제목 없음)") or "(제목 없음)"
            clean_sub = em.get("clean_subject") or clean_subject(subject)
            thread_key = em.get("thread_key") or clean_sub.lower()
            from_addr = em.get("from") or em.get("from_addr", "") or ""
            to_addr = em.get("to") or em.get("to_addr", "") or ""
            date_str = em.get("date") or em.get("date_str", "") or ""
            category = em.get("category") or "기타"
            snippet = em.get("snippet", "") or ""
            body_text = em.get("body_text", "") or ""
            body_html = em.get("body_html", "") or ""
            
            raw_att = em.get("attachments")
            if raw_att is None:
                raw_att = em.get("attachments_json", "[]")
            if isinstance(raw_att, (list, dict)):
                attachments_json = json.dumps(raw_att, ensure_ascii=False)
            else:
                attachments_json = str(raw_att) if raw_att else "[]"

            message_id = em.get("message_id", "") or ""
            in_reply_to = em.get("in_reply_to", "") or ""
            references_header = em.get("references") or em.get("references_header", "") or ""
            file_path = em.get("file_path", "") or ""
            created_at = em.get("created_at", "") or ""

            records.append((
                em_id, subject, clean_sub, thread_key,
                from_addr, to_addr, date_str, category,
                snippet, body_text, body_html, attachments_json,
                message_id, in_reply_to, references_header,
                file_path, created_at
            ))

        with conn:
            conn.executemany("""
                INSERT OR REPLACE INTO emails (
                    id, subject, clean_subject, thread_key,
                    from_addr, to_addr, date_str, category,
                    snippet, body_text, body_html, attachments_json,
                    message_id, in_reply_to, references_header,
                    file_path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, records)

        _safe_log(f"[SQLite Migration] 총 {len(records):,}개의 이메일이 data/app.db로 성공적으로 마이그레이션되었습니다!")
    except Exception as e:
        _safe_log(f"[SQLite Migration] 이메일 마이그레이션 실패: {e}")


def _migrate_notes_from_json_if_needed(conn):
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM notes")
    count = cursor.fetchone()[0]
    if count > 0:
        return

    json_path = None
    if os.path.exists(NOTES_JSON_PATH):
        json_path = NOTES_JSON_PATH
    elif os.path.exists(NOTES_EXAMPLE_PATH):
        json_path = NOTES_EXAMPLE_PATH

    if not json_path:
        return

    _safe_log(f"[SQLite Migration] {os.path.basename(json_path)}에서 notes 테이블로 데이터 이전 중...")
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            notes_data = json.load(f)

        if not isinstance(notes_data, list) or len(notes_data) == 0:
            return

        records = []
        for idx, item in enumerate(notes_data):
            note_id = str(item.get("id") or f"note_{int(time.time() * 1000)}_{idx}")
            title = item.get("title", "") or ""
            content = item.get("content", "") or ""
            category = item.get("category", "") or ""
            color = item.get("color", "") or ""
            is_pinned = 1 if item.get("is_pinned") else 0
            updated_at = item.get("updated_at") or item.get("updatedAt") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            created_at = item.get("created_at") or item.get("createdAt") or updated_at

            records.append((
                note_id, title, content, category, color, is_pinned, created_at, updated_at
            ))

        with conn:
            conn.executemany("""
                INSERT OR REPLACE INTO notes (
                    id, title, content, category, color, is_pinned, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, records)

        _safe_log(f"[SQLite Migration] 총 {len(records):,}개의 메모가 data/app.db(notes)로 성공적으로 마이그레이션되었습니다!")
    except Exception as e:
        _safe_log(f"[SQLite Migration] 메모 마이그레이션 실패: {e}")


def _migrate_diagrams_from_json_if_needed(conn):
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM diagrams")
    count = cursor.fetchone()[0]
    if count > 0:
        return

    json_path = None
    if os.path.exists(DIAGRAMS_JSON_PATH):
        json_path = DIAGRAMS_JSON_PATH
    elif os.path.exists(DIAGRAMS_EXAMPLE_PATH):
        json_path = DIAGRAMS_EXAMPLE_PATH

    if not json_path:
        return

    _safe_log(f"[SQLite Migration] {os.path.basename(json_path)}에서 diagrams 테이블로 데이터 이전 중...")
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            diagrams_data = json.load(f)

        if not isinstance(diagrams_data, list) or len(diagrams_data) == 0:
            return

        records = []
        for idx, item in enumerate(diagrams_data):
            diag_id = str(item.get("id") or f"diag_{int(time.time() * 1000)}_{idx}")
            title = item.get("title", "") or ""
            code = item.get("code", "") or ""
            category = item.get("category", "") or ""
            diag_type = item.get("type", "") or ""
            description = item.get("description", "") or ""
            updated_at = item.get("updated_at") or item.get("updatedAt") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            created_at = item.get("created_at") or item.get("createdAt") or updated_at

            records.append((
                diag_id, title, code, category, diag_type, description, created_at, updated_at
            ))

        with conn:
            conn.executemany("""
                INSERT OR REPLACE INTO diagrams (
                    id, title, code, category, type, description, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, records)

        _safe_log(f"[SQLite Migration] 총 {len(records):,}개의 다이어그램이 data/app.db(diagrams)로 성공적으로 마이그레이션되었습니다!")
    except Exception as e:
        _safe_log(f"[SQLite Migration] 다이어그램 마이그레이션 실패: {e}")


def _migrate_quick_launch_from_json_if_needed(conn):
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM quick_launch")
    count = cursor.fetchone()[0]
    if count > 0:
        return

    json_path = None
    if os.path.exists(QUICK_LAUNCH_JSON_PATH):
        json_path = QUICK_LAUNCH_JSON_PATH
    elif os.path.exists(QUICK_LAUNCH_EXAMPLE_PATH):
        json_path = QUICK_LAUNCH_EXAMPLE_PATH

    if not json_path:
        return

    _safe_log(f"[SQLite Migration] {os.path.basename(json_path)}에서 quick_launch 테이블로 데이터 이전 중...")
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            ql_data = json.load(f)

        if not isinstance(ql_data, list) or len(ql_data) == 0:
            return

        records = []
        for idx, item in enumerate(ql_data):
            ql_id = str(item.get("id") or f"ql_{int(time.time() * 1000)}_{idx}")
            title = item.get("name") or item.get("title", "") or ""
            path = item.get("command") or item.get("path", "") or ""
            icon = item.get("icon", "⚡") or "⚡"
            category = item.get("type") or item.get("category", "cmd") or "cmd"
            description = item.get("desc") or item.get("description", "") or ""
            order_index = int(item.get("order_index", idx))
            created_at = item.get("created_at") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            records.append((
                ql_id, title, path, icon, category, description, order_index, created_at
            ))

        with conn:
            conn.executemany("""
                INSERT OR REPLACE INTO quick_launch (
                    id, title, path, icon, category, description, order_index, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, records)

        _safe_log(f"[SQLite Migration] 총 {len(records):,}개의 빠른 실행 항목이 data/app.db(quick_launch)로 성공적으로 마이그레이션되었습니다!")
    except Exception as e:
        _safe_log(f"[SQLite Migration] 빠른 실행 마이그레이션 실패: {e}")


def _migrate_shortcuts_from_json_if_needed(conn):
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM shortcuts")
    count = cursor.fetchone()[0]
    if count > 0:
        return

    json_path = None
    if os.path.exists(SHORTCUTS_JSON_PATH):
        json_path = SHORTCUTS_JSON_PATH
    elif os.path.exists(SHORTCUTS_EXAMPLE_PATH):
        json_path = SHORTCUTS_EXAMPLE_PATH

    if not json_path:
        return

    _safe_log(f"[SQLite Migration] {os.path.basename(json_path)}에서 shortcuts 테이블로 데이터 이전 중...")
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            sc_data = json.load(f)

        if not isinstance(sc_data, list) or len(sc_data) == 0:
            return

        records = []
        for idx, item in enumerate(sc_data):
            sc_id = str(item.get("id") or f"sc_{int(time.time() * 1000)}_{idx}")
            title = item.get("name") or item.get("title", "") or ""
            key_combo = item.get("key_combo", "") or ""
            url_or_path = item.get("path") or item.get("url_or_path", "") or ""
            category = item.get("category", "folder") or "folder"
            description = item.get("description") or item.get("desc", "") or ""
            icon = item.get("icon", "📁") or "📁"
            created_at = item.get("created_at") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            records.append((
                sc_id, title, key_combo, url_or_path, category, description, icon, created_at
            ))

        with conn:
            conn.executemany("""
                INSERT OR REPLACE INTO shortcuts (
                    id, title, key_combo, url_or_path, category, description, icon, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, records)

        _safe_log(f"[SQLite Migration] 총 {len(records):,}개의 바로가기가 data/app.db(shortcuts)로 성공적으로 마이그레이션되었습니다!")
    except Exception as e:
        _safe_log(f"[SQLite Migration] 바로가기 마이그레이션 실패: {e}")


def _migrate_generators_from_json_if_needed(conn):
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM generators")
    count = cursor.fetchone()[0]
    if count > 0:
        return

    json_path = None
    if os.path.exists(GENERATORS_JSON_PATH):
        json_path = GENERATORS_JSON_PATH
    elif os.path.exists(GENERATORS_EXAMPLE_PATH):
        json_path = GENERATORS_EXAMPLE_PATH

    if not json_path:
        return

    _safe_log(f"[SQLite Migration] {os.path.basename(json_path)}에서 generators 테이블로 데이터 이전 중...")
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            gen_data = json.load(f)

        if not isinstance(gen_data, list) or len(gen_data) == 0:
            return

        records = []
        for idx, item in enumerate(gen_data):
            gen_id = str(item.get("id") or f"gen_{int(time.time() * 1000)}_{idx}")
            title = item.get("name") or item.get("title", "") or ""
            language = item.get("language", "javascript") or "javascript"
            template = item.get("code") or item.get("template", "") or ""
            description = item.get("description", "") or ""
            category = item.get("category", "") or ""
            icon = item.get("icon", "🔢") or "🔢"
            
            raw_vars = item.get("variables_json") or item.get("variables", "[]")
            if isinstance(raw_vars, (list, dict)):
                variables_json = json.dumps(raw_vars, ensure_ascii=False)
            else:
                variables_json = str(raw_vars) if raw_vars else "[]"
            created_at = item.get("created_at") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            records.append((
                gen_id, title, language, template, description, category, icon, variables_json, created_at
            ))

        with conn:
            conn.executemany("""
                INSERT OR REPLACE INTO generators (
                    id, title, language, template, description, category, icon, variables_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, records)

        _safe_log(f"[SQLite Migration] 총 {len(records):,}개의 데이터 생성기가 data/app.db(generators)로 성공적으로 마이그레이션되었습니다!")
    except Exception as e:
        _safe_log(f"[SQLite Migration] 데이터 생성기 마이그레이션 실패: {e}")


def init_db():
    """데이터베이스 테이블 생성, 인덱스 생성 및 전체 JSON 모듈 초기 데이터 마이그레이션 수행"""
    global _is_initialized
    if _is_initialized:
        return

    with _init_lock:
        if _is_initialized:
            return

        _ensure_data_dir()
        conn = get_db_connection()
        try:
            with conn:
                # 1. emails 테이블
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS emails (
                        id TEXT PRIMARY KEY,
                        subject TEXT,
                        clean_subject TEXT,
                        thread_key TEXT,
                        from_addr TEXT,
                        to_addr TEXT,
                        date_str TEXT,
                        category TEXT DEFAULT '기타',
                        snippet TEXT,
                        body_text TEXT,
                        body_html TEXT,
                        attachments_json TEXT DEFAULT '[]',
                        message_id TEXT,
                        in_reply_to TEXT,
                        references_header TEXT,
                        file_path TEXT,
                        created_at TEXT
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_emails_thread_key ON emails(thread_key);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date_str);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_emails_created_at ON emails(created_at);")

                # 2. notes 테이블
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS notes (
                        id TEXT PRIMARY KEY,
                        title TEXT,
                        content TEXT,
                        category TEXT DEFAULT '',
                        color TEXT DEFAULT '',
                        is_pinned INTEGER DEFAULT 0,
                        created_at TEXT,
                        updated_at TEXT
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(is_pinned);")

                # 3. diagrams 테이블
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS diagrams (
                        id TEXT PRIMARY KEY,
                        title TEXT,
                        code TEXT,
                        category TEXT,
                        type TEXT DEFAULT '',
                        description TEXT,
                        created_at TEXT,
                        updated_at TEXT
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_diagrams_category ON diagrams(category);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_diagrams_updated_at ON diagrams(updated_at);")

                # 4. quick_launch 테이블
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS quick_launch (
                        id TEXT PRIMARY KEY,
                        title TEXT,
                        path TEXT,
                        icon TEXT DEFAULT '⚡',
                        category TEXT DEFAULT 'cmd',
                        description TEXT DEFAULT '',
                        order_index INTEGER DEFAULT 0,
                        created_at TEXT
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_quick_launch_order ON quick_launch(order_index);")

                # 5. shortcuts 테이블
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS shortcuts (
                        id TEXT PRIMARY KEY,
                        title TEXT,
                        key_combo TEXT DEFAULT '',
                        url_or_path TEXT,
                        category TEXT DEFAULT 'folder',
                        description TEXT DEFAULT '',
                        icon TEXT DEFAULT '📁',
                        created_at TEXT
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_shortcuts_category ON shortcuts(category);")

                # 6. generators 테이블
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS generators (
                        id TEXT PRIMARY KEY,
                        title TEXT,
                        language TEXT DEFAULT 'javascript',
                        template TEXT,
                        description TEXT,
                        category TEXT,
                        icon TEXT DEFAULT '🔢',
                        variables_json TEXT DEFAULT '[]',
                        created_at TEXT
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_generators_category ON generators(category);")

                # 7. mock_templates 테이블 (커스텀 모의 데이터 양식)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS mock_templates (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        description TEXT DEFAULT '',
                        icon TEXT DEFAULT '📋',
                        schema_json TEXT NOT NULL,
                        created_at TEXT,
                        updated_at TEXT
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_mock_templates_updated ON mock_templates(updated_at);")

            # 1회 자동 마이그레이션 실행
            _migrate_emails_from_json_if_needed(conn)
            _migrate_notes_from_json_if_needed(conn)
            _migrate_diagrams_from_json_if_needed(conn)
            _migrate_quick_launch_from_json_if_needed(conn)
            _migrate_shortcuts_from_json_if_needed(conn)
            _migrate_generators_from_json_if_needed(conn)

            _is_initialized = True
        finally:
            conn.close()


# 모듈 임포트 시 DB 자동 초기화
init_db()
