"""
Mermaid 다이어그램 데이터 관리 및 SQLite 영속화 서비스 모듈
"""
import datetime
import eel
from services.db_service import get_db_connection

DEFAULT_DIAGRAMS = [
    {
        "id": "1",
        "title": "⚡ 서비스 아키텍처 & 캐싱 흐름도",
        "category": "Flowchart",
        "type": "flowchart",
        "description": "API 게이트웨이, Redis 캐시 확인 및 DB 쿼리 흐름도",
        "code": """flowchart TD
    Start([사용자 요청]) --> AuthCheck{인증 여부}
    AuthCheck -- 인증 성공 --> CacheCheck{캐시 확인}
    AuthCheck -- 인증 실패 --> Reject[401 권한 없음]
    
    CacheCheck -- Cache Hit --> ReturnCache[캐시 데이터 즉시 반환]
    CacheCheck -- Cache Miss --> QueryDB[(데이터베이스 조회)]
    
    QueryDB --> SaveCache[결과 캐싱 (Redis)]
    SaveCache --> ReturnResponse([클라이언트 응답])
    ReturnCache --> ReturnResponse""",
        "created_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
]


@eel.expose
def get_diagrams():
    """저장된 다이어그램 목록 불러오기 (SQLite 조회, 없으면 기본값 삽입 후 반환)"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, title, code, category, type, description, created_at, updated_at
                FROM diagrams
                ORDER BY updated_at DESC, created_at DESC
            """)
            rows = cursor.fetchall()

            if not rows:
                records = []
                for d in DEFAULT_DIAGRAMS:
                    records.append((
                        d["id"], d["title"], d["code"], d.get("category", ""),
                        d.get("type", ""), d.get("description", ""),
                        d.get("created_at", ""), d.get("updated_at", "")
                    ))
                with conn:
                    conn.executemany("""
                        INSERT OR REPLACE INTO diagrams (
                            id, title, code, category, type, description, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)
                cursor.execute("""
                    SELECT id, title, code, category, type, description, created_at, updated_at
                    FROM diagrams
                    ORDER BY updated_at DESC, created_at DESC
                """)
                rows = cursor.fetchall()

            data = []
            for r in rows:
                updated_at_val = r["updated_at"] or r["created_at"] or ""
                data.append({
                    "id": str(r["id"]),
                    "title": r["title"] or "",
                    "code": r["code"] or "",
                    "category": r["category"] or "",
                    "type": r["type"] or "",
                    "description": r["description"] or "",
                    "created_at": r["created_at"] or "",
                    "updated_at": updated_at_val,
                    "updatedAt": updated_at_val
                })
            return {"status": "success", "data": data}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_DIAGRAMS}


@eel.expose
def save_diagrams(diagrams_data):
    """다이어그램 목록 저장하기 (SQLite 트랜잭션 동기화)"""
    try:
        if not isinstance(diagrams_data, list):
            return {"status": "error", "message": "유효한 다이어그램 목록 형식이 아닙니다."}

        conn = get_db_connection()
        try:
            records = []
            active_ids = []
            for d in diagrams_data:
                did = str(d.get("id") or "")
                if not did:
                    continue
                active_ids.append(did)
                title = d.get("title", "") or ""
                code = d.get("code", "") or ""
                category = d.get("category", "") or ""
                diag_type = d.get("type", "") or ""
                description = d.get("description", "") or ""
                updated_at = d.get("updated_at") or d.get("updatedAt") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                created_at = d.get("created_at") or d.get("createdAt") or updated_at
                records.append((did, title, code, category, diag_type, description, created_at, updated_at))

            with conn:
                if active_ids:
                    placeholders = ",".join("?" for _ in active_ids)
                    conn.execute(f"DELETE FROM diagrams WHERE id NOT IN ({placeholders})", active_ids)
                else:
                    conn.execute("DELETE FROM diagrams")

                if records:
                    conn.executemany("""
                        INSERT OR REPLACE INTO diagrams (
                            id, title, code, category, type, description, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)

            return {"status": "success", "message": "다이어그램 목록이 안전하게 저장되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}
