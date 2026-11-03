"""
IMAP Email Archive & Vector DB Sync 백엔드 기능 테스트 (scripts/test_imap_functional.py)
- services.imap_service 및 services.ai_search_service 연동 검증
- SQLite imap_accounts 테이블 CRUD 및 설정 영속화
- 신규 이메일의 AI 벡터 DB (ai_embeddings) 즉시 임베딩 파이프라인 검증
"""

import sys
import uuid
import time
from pathlib import Path

# 루트 디렉토리 sys.path 추가
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from services.db_service import init_db, get_db_connection
from services.imap_service import (
    get_imap_config,
    save_imap_config,
    test_imap_connection,
    _normalize_imap_credentials,
    _format_imap_error,
    _decode_imap_utf7,
    _quote_imap_folder
)
from services.ai_search_service import embed_new_emails


def test_imap_config_crud():
    print("[RUN] test_imap_config_crud...")
    init_db()

    # 기존 DB 레코드 백업 (사용자 설정 보호)
    conn = get_db_connection()
    backup_rows = []
    try:
        rows = conn.execute("SELECT * FROM imap_accounts").fetchall()
        backup_rows = [dict(r) for r in rows if r["username"] != "tester@example.com"]
        conn.execute("DELETE FROM imap_accounts")
        conn.commit()
    finally:
        conn.close()

    try:
        # 1. 설정 저장
        test_cfg = {
            "account_name": "업무용 Gmail",
            "host": "imap.gmail.com",
            "port": 993,
            "use_ssl": True,
            "username": "tester@example.com",
            "password": "app_password_secret",
            "folder": "INBOX"
        }
        save_res = save_imap_config(test_cfg)
        assert save_res["status"] == "success"

        # 2. 설정 조회
        get_res = get_imap_config()
        assert get_res["status"] == "success"
        cfg = get_res["config"]
        assert cfg["account_name"] == "업무용 Gmail"
        assert cfg["host"] == "imap.gmail.com"
        assert cfg["port"] == 993
        assert cfg["use_ssl"] is True
        assert cfg["username"] == "tester@example.com"
        assert cfg["password"] == "app_password_secret"
        assert cfg["folder"] == "INBOX"

        # 3. 설정 업데이트
        test_cfg["folder"] = "Sent"
        update_res = save_imap_config(test_cfg)
        assert update_res["status"] == "success"

        updated_cfg = get_imap_config()["config"]
        assert updated_cfg["folder"] == "Sent"
    finally:
        # 테스트 더미 제거 및 기존 사용자 설정 복원
        conn = get_db_connection()
        try:
            conn.execute("DELETE FROM imap_accounts")
            for r in backup_rows:
                conn.execute("""
                    INSERT INTO imap_accounts (id, account_name, host, port, use_ssl, username, password, folder, last_sync_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    r["id"], r["account_name"], r["host"], r["port"], r["use_ssl"],
                    r["username"], r["password"], r["folder"], r["last_sync_at"],
                    r["created_at"], r["updated_at"]
                ))
            conn.commit()
        finally:
            conn.close()

    print("  [PASS] test_imap_config_crud")


def test_imap_connection_validation():
    print("[RUN] test_imap_connection_validation...")
    # 1. Google 앱 비밀번호(4x4 공백 포함) 및 아이디 정규화 검증
    h, u, p = _normalize_imap_credentials(" imap.gmail.com ", "myuser", " abcd efgh ijkl mnop ")
    assert h == "imap.gmail.com"
    assert u == "myuser@gmail.com"
    assert p == "abcdefghijklmnop"

    # 2. 에러 메시지 한국어 안내 포매팅 검증
    msg1 = _format_imap_error(Exception(b"[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)"), "imap.gmail.com")
    assert "앱 비밀번호" in msg1

    msg2 = _format_imap_error(Exception(b"[AUTHENTICATIONFAILED] Invalid credentials (Failure)"), "imap.gmail.com")
    assert "Invalid credentials" in msg2

    # 3. 빈 파라미터 유효성 검증
    res_empty = test_imap_connection("", 993, True, "", "")
    assert res_empty["status"] == "error"
    assert "모두 입력" in res_empty["message"]

    # 4. 잘못된 호스트 연결 실패 검증 (타임아웃 핸들링)
    res_invalid = test_imap_connection("invalid.host.nonexistent.local", 993, True, "user", "pass")
    assert res_invalid["status"] == "error"

    # 5. Gmail 한국어 사서함 Modified UTF-7 디코딩 및 쿼팅 검증
    assert _decode_imap_utf7("[Gmail]/&vPSwuNO4ycDVaA-") == "[Gmail]/보낸편지함"
    assert _quote_imap_folder("[Gmail]/All Mail") == '"[Gmail]/All Mail"'
    assert _quote_imap_folder("INBOX") == "INBOX"

    print("  [PASS] test_imap_connection_validation")


def test_email_auto_vector_embedding():
    print("[RUN] test_email_auto_vector_embedding...")
    init_db()

    # 가상 이메일 레코드 생성
    test_id = f"test_email_{uuid.uuid4().hex[:8]}"
    test_email = {
        "id": test_id,
        "subject": "[보안 공지] 정기 서버 패치 및 인프라 점검 안내",
        "clean_subject": "정기 서버 패치 및 인프라 점검 안내",
        "from": "security@company.com",
        "to": "all@company.com",
        "category": "시스템/알림",
        "snippet": "이번 주말 데이터베이스 서버 정기 보안 패치가 예정되어 있습니다.",
        "body_text": "상세 점검 시간: 일요일 02:00 ~ 05:00. 해당 시간 동안 서비스가 일시 중단됩니다."
    }

    # embed_new_emails 호출
    embedded_count = embed_new_emails([test_email])
    print(f"  Embedded count: {embedded_count}")

    # SQLite ai_embeddings 테이블에 레코드가 들어갔는지 확인
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT key, hash, vector FROM ai_embeddings WHERE key = ?", (f"emails_{test_id}",)).fetchone()
        assert row is not None, "ai_embeddings 테이블에 이메일 벡터가 저장되어야 함"
        assert row["key"] == f"emails_{test_id}"
        assert row["vector"] is not None
        assert len(row["vector"]) > 0, "임베딩 바이너리 데이터가 존재해야 함"
        print(f"  Vector bytes length: {len(row['vector'])} (float32 x 384 dims = 1536 bytes)")
        assert len(row["vector"]) == 1536, "384차원 float32 벡터 크기(1536바이트) 일치"
    finally:
        # 테스트 데이터 정리
        conn.execute("DELETE FROM ai_embeddings WHERE key = ?", (f"emails_{test_id}",))
        conn.commit()
        conn.close()

    print("  [PASS] test_email_auto_vector_embedding")


if __name__ == "__main__":
    print("=" * 60)
    print("  Running IMAP Email Archive & Vector Sync Functional Tests")
    print("=" * 60)
    test_imap_config_crud()
    test_imap_connection_validation()
    test_email_auto_vector_embedding()
    print("=" * 60)
    print("  All IMAP & Vector Sync Functional Tests Passed Successfully!")
    print("=" * 60)
