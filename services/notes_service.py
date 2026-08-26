"""
빠른 메모(Notes / Scratchpad) 데이터 관리 및 SQLite 영속화 서비스 모듈
"""
import datetime
import eel
from services.db_service import get_db_connection

DEFAULT_NOTES = [
    {
        "id": "1",
        "title": "📌 오늘의 할 일",
        "content": "- [ ] 주간 업무 정리\n- [ ] 코드 리뷰 및 테스트\n- [ ] 서버 상태 점검",
        "category": "업무",
        "color": "#3b82f6",
        "is_pinned": 1,
        "created_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    },
    {
        "id": "2",
        "title": "🧪 임시 스크래치패드",
        "content": "// 임시 SQL 쿼리, JSON, 토큰, 명령어 등을 자유롭게 적어두세요.\n// 입력하는 즉시 로컬 PC에 안전하게 자동 저장됩니다.",
        "category": "스크래치",
        "color": "#10b981",
        "is_pinned": 0,
        "created_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
]


@eel.expose
def get_notes():
    """저장된 메모 목록 불러오기 (SQLite 조회, 없으면 기본값 삽입 후 반환)"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, title, content, category, color, is_pinned, created_at, updated_at
                FROM notes
                ORDER BY is_pinned DESC, updated_at DESC, created_at DESC
            """)
            rows = cursor.fetchall()

            if not rows:
                records = []
                for n in DEFAULT_NOTES:
                    records.append((
                        n["id"], n["title"], n["content"],
                        n.get("category", ""), n.get("color", ""),
                        n.get("is_pinned", 0), n.get("created_at", ""), n.get("updated_at", "")
                    ))
                with conn:
                    conn.executemany("""
                        INSERT OR REPLACE INTO notes (
                            id, title, content, category, color, is_pinned, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)
                cursor.execute("""
                    SELECT id, title, content, category, color, is_pinned, created_at, updated_at
                    FROM notes
                    ORDER BY is_pinned DESC, updated_at DESC, created_at DESC
                """)
                rows = cursor.fetchall()

            data = []
            for r in rows:
                updated_at_val = r["updated_at"] or r["created_at"] or ""
                data.append({
                    "id": str(r["id"]),
                    "title": r["title"] or "",
                    "content": r["content"] or "",
                    "category": r["category"] or "",
                    "color": r["color"] or "",
                    "is_pinned": bool(r["is_pinned"]),
                    "created_at": r["created_at"] or "",
                    "updated_at": updated_at_val,
                    "updatedAt": updated_at_val
                })
            return {"status": "success", "data": data}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_NOTES}


@eel.expose
def save_notes(notes_data):
    """메모 목록 전체 동기화/저장하기 (SQLite 트랜잭션)"""
    try:
        if not isinstance(notes_data, list):
            return {"status": "error", "message": "유효한 메모 목록 형식이 아닙니다."}

        conn = get_db_connection()
        try:
            records = []
            active_ids = []
            for n in notes_data:
                nid = str(n.get("id") or "")
                if not nid:
                    continue
                active_ids.append(nid)
                title = n.get("title", "") or ""
                content = n.get("content", "") or ""
                category = n.get("category", "") or ""
                color = n.get("color", "") or ""
                is_pinned = 1 if n.get("is_pinned") else 0
                updated_at = n.get("updated_at") or n.get("updatedAt") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                created_at = n.get("created_at") or n.get("createdAt") or updated_at
                records.append((nid, title, content, category, color, is_pinned, created_at, updated_at))

            with conn:
                if active_ids:
                    placeholders = ",".join("?" for _ in active_ids)
                    conn.execute(f"DELETE FROM notes WHERE id NOT IN ({placeholders})", active_ids)
                else:
                    conn.execute("DELETE FROM notes")

                if records:
                    conn.executemany("""
                        INSERT OR REPLACE INTO notes (
                            id, title, content, category, color, is_pinned, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)

            return {"status": "success", "message": "메모가 안전하게 자동 저장되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}
