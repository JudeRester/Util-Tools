"""
빠른 메모(Notes / Scratchpad) 데이터 관리 및 SQLite 영속화 서비스 모듈
"""
import datetime
import time
import eel
from services.db_service import get_db_connection

DEFAULT_NOTES = [
    {
        "id": "1",
        "title": "📌 오늘의 할 일",
        "content": "- [ ] 주간 업무 정리\n- [ ] 코드 리뷰 및 테스트\n- [ ] 서버 상태 점검",
        "category": "work",
        "color": "#3b82f6",
        "is_pinned": 1,
        "created_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    },
    {
        "id": "2",
        "title": "🧪 임시 스크래치패드",
        "content": "// 임시 SQL 쿼리, JSON, 토큰, 명령어 등을 자유롭게 적어두세요.\n// 입력하는 즉시 로컬 PC에 안전하게 자동 저장됩니다.",
        "category": "scratch",
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
                        n.get("category", "scratch"), n.get("color", ""),
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
                cat_val = r["category"] or "scratch"
                # 이전 버전의 한글 카테고리 호환 매핑 ('업무' -> 'work', '스크래치' -> 'scratch')
                if cat_val == "업무":
                    cat_val = "work"
                elif cat_val == "스크래치":
                    cat_val = "scratch"

                data.append({
                    "id": str(r["id"]),
                    "title": r["title"] or "",
                    "content": r["content"] or "",
                    "category": cat_val,
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
                category = n.get("category", "") or "scratch"
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


@eel.expose
def get_note_categories():
    """메모 카테고리(상위 보관함) 목록 조회 (소속 메모 개수 포함)"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            # 전체 메모 수
            cursor.execute("SELECT COUNT(*) FROM notes")
            total_count = cursor.fetchone()[0]

            # 카테고리 목록
            cursor.execute("""
                SELECT id, name, icon, sort_order, is_system, created_at, updated_at
                FROM note_categories
                ORDER BY sort_order ASC, created_at ASC
            """)
            rows = cursor.fetchall()

            # 카테고리별 메모 수 집계
            cursor.execute("""
                SELECT category, COUNT(*) as cnt 
                FROM notes 
                GROUP BY category
            """)
            counts_map = {r["category"]: r["cnt"] for r in cursor.fetchall()}

            categories = []
            for r in rows:
                cid = str(r["id"])
                if cid == "all":
                    cnt = total_count
                else:
                    cnt = counts_map.get(cid, 0)

                categories.append({
                    "id": cid,
                    "name": r["name"],
                    "icon": r["icon"] or "📁",
                    "sort_order": r["sort_order"],
                    "is_system": bool(r["is_system"]),
                    "notes_count": cnt,
                    "created_at": r["created_at"] or "",
                    "updated_at": r["updated_at"] or ""
                })
            return {"status": "success", "data": categories}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e), "data": []}


@eel.expose
def save_note_category(cat_id, name, icon="📁"):
    """메모 카테고리 생성 또는 수정"""
    try:
        name = (name or "").strip()
        if not name:
            return {"status": "error", "message": "카테고리 이름을 입력해 주세요."}

        icon = (icon or "📁").strip()
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            with conn:
                if cat_id and cat_id != "new":
                    # 수정 모드
                    cursor.execute("SELECT is_system FROM note_categories WHERE id = ?", (cat_id,))
                    row = cursor.fetchone()
                    if row and row["is_system"] and cat_id == "all":
                        return {"status": "error", "message": "'전체 메모' 보관함은 수정할 수 없습니다."}

                    cursor.execute("""
                        UPDATE note_categories
                        SET name = ?, icon = ?, updated_at = datetime('now', 'localtime')
                        WHERE id = ?
                    """, (name, icon, cat_id))
                    saved_id = cat_id
                else:
                    # 신규 생성 모드
                    saved_id = f"cat_{int(time.time() * 1000)}"
                    cursor.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM note_categories")
                    next_order = cursor.fetchone()[0]

                    cursor.execute("""
                        INSERT INTO note_categories (id, name, icon, sort_order, is_system)
                        VALUES (?, ?, ?, ?, 0)
                    """, (saved_id, name, icon, next_order))

            return {"status": "success", "message": "보관함이 저장되었습니다.", "id": saved_id}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def delete_note_category(cat_id):
    """메모 카테고리 삭제 (소속 메모는 기본 스크래치패드로 안전하게 자동 이전)"""
    try:
        if not cat_id:
            return {"status": "error", "message": "유효하지 않은 보관함 ID입니다."}

        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT is_system, name FROM note_categories WHERE id = ?", (cat_id,))
            row = cursor.fetchone()
            if not row:
                return {"status": "error", "message": "해당 보관함을 찾을 수 없습니다."}

            if row["is_system"]:
                return {"status": "error", "message": "시스템 기본 보관함은 삭제할 수 없습니다."}

            with conn:
                # 1. 소속 메모들을 기본 스크래치패드('scratch')로 이전
                cursor.execute("""
                    UPDATE notes 
                    SET category = 'scratch', updated_at = datetime('now', 'localtime')
                    WHERE category = ?
                """, (cat_id,))

                # 2. 카테고리 삭제
                cursor.execute("DELETE FROM note_categories WHERE id = ?", (cat_id,))

            return {"status": "success", "message": f"'{row['name']}' 보관함이 삭제되었으며, 소속 메모는 스크래치패드로 안전하게 이동되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def reorder_note_categories(ordered_ids):
    """보관함 순서 일괄 갱신 (전체 메모 'all'은 0순위 고정)"""
    try:
        if not isinstance(ordered_ids, list):
            return {"status": "error", "message": "유효한 ID 목록이 아닙니다."}

        conn = get_db_connection()
        try:
            with conn:
                order = 1
                for cid in ordered_ids:
                    if cid == "all":
                        conn.execute("UPDATE note_categories SET sort_order = 0 WHERE id = 'all'")
                    else:
                        conn.execute("UPDATE note_categories SET sort_order = ? WHERE id = ?", (order, cid))
                        order += 1

            return {"status": "success", "message": "보관함 순서가 변경되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}

