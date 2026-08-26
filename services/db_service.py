"""
중앙 SQLite 데이터베이스 관리자 및 커넥션 풀 매니저
- 데이터베이스 파일: data/app.db
- WAL 모드 및 고성능/충돌방지 PRAGMA 설정
- emails 테이블 및 고속 검색 인덱스 관리
- emails.json 데이터 최초 1회 자동 마이그레이션
"""
import os
import json
import sqlite3
import re
import threading

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(base_dir, "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")
EMAILS_JSON_PATH = os.path.join(base_dir, "emails.json")
EMAILS_EXAMPLE_PATH = os.path.join(base_dir, "emails.example.json")

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
    """emails.json이 존재하고 emails 테이블이 비어있는 경우 최초 1회 단일 트랜잭션으로 마이그레이션"""
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

    _safe_log(f"[SQLite Migration] {os.path.basename(json_path)}에서 SQLite(app.db)로 데이터 이전 중...")
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
                em_id,
                subject,
                clean_sub,
                thread_key,
                from_addr,
                to_addr,
                date_str,
                category,
                snippet,
                body_text,
                body_html,
                attachments_json,
                message_id,
                in_reply_to,
                references_header,
                file_path,
                created_at
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
        _safe_log(f"[SQLite Migration] 마이그레이션 실패: {e}")


def init_db():
    """데이터베이스 테이블 생성, 인덱스 생성 및 초기 데이터 마이그레이션 수행"""
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

            _migrate_emails_from_json_if_needed(conn)
            _is_initialized = True
        finally:
            conn.close()


# 모듈 임포트 시 DB 자동 초기화
init_db()
