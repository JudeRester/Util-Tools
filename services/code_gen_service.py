"""
코드 & 데이터 생성기(Code Generator) 템플릿 관리 및 SQLite 영속화 서비스 모듈
"""
import datetime
import json
import eel
from services.db_service import get_db_connection

DEFAULT_GENERATORS = [
    {
        "id": "1",
        "title": "SQL INSERT 문 대량 생성",
        "name": "SQL INSERT 문 대량 생성",
        "language": "sql",
        "description": "사용자 목록 테스트용 대량 INSERT 쿼리 템플릿",
        "category": "SQL",
        "icon": "🗄️",
        "template": "-- 테이블: users\nINSERT INTO users (user_id, username, email, role, created_at)\nVALUES ('user_{{index}}', '홍길동_{{index}}', 'user{{index}}@example.com', '{{role|USER}}', NOW());",
        "code": "-- 테이블: users\nINSERT INTO users (user_id, username, email, role, created_at)\nVALUES ('user_{{index}}', '홍길동_{{index}}', 'user{{index}}@example.com', '{{role|USER}}', NOW());",
        "variables_json": '[{"name": "role", "label": "기본 권한", "default": "USER"}]',
        "variables": [{"name": "role", "label": "기본 권한", "default": "USER"}],
        "created_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    },
    {
        "id": "2",
        "title": "TypeScript 인터페이스 DTO",
        "name": "TypeScript 인터페이스 DTO",
        "language": "typescript",
        "description": "API 응답용 제네릭 ApiResponse DTO",
        "category": "TypeScript",
        "icon": "🔷",
        "template": "export interface ApiResponse<T> {\n  statusCode: number;\n  message: string;\n  data: T;\n  timestamp: string;\n}",
        "code": "export interface ApiResponse<T> {\n  statusCode: number;\n  message: string;\n  data: T;\n  timestamp: string;\n}",
        "variables_json": '[]',
        "variables": [],
        "created_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
]


@eel.expose
def get_code_generators():
    """저장된 코드/데이터 생성기 템플릿 목록 불러오기 (SQLite 조회, 없으면 기본값 삽입 후 반환)"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, title, language, template, description, category, icon, variables_json, created_at
                FROM generators
                ORDER BY id ASC
            """)
            rows = cursor.fetchall()

            if not rows:
                records = []
                for gen in DEFAULT_GENERATORS:
                    vars_str = gen.get("variables_json") or json.dumps(gen.get("variables", []), ensure_ascii=False)
                    records.append((
                        gen["id"], gen["title"], gen.get("language", "javascript"),
                        gen.get("template", ""), gen.get("description", ""),
                        gen.get("category", "기타"), gen.get("icon", "🔢"),
                        vars_str, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    ))
                with conn:
                    conn.executemany("""
                        INSERT OR REPLACE INTO generators (
                            id, title, language, template, description, category, icon, variables_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)
                cursor.execute("""
                    SELECT id, title, language, template, description, category, icon, variables_json, created_at
                    FROM generators
                    ORDER BY id ASC
                """)
                rows = cursor.fetchall()

            data = []
            for r in rows:
                raw_vars = r["variables_json"] or "[]"
                try:
                    vars_list = json.loads(raw_vars) if isinstance(raw_vars, str) else raw_vars
                except Exception:
                    vars_list = []

                title = r["title"] or ""
                tmpl = r["template"] or ""
                desc = r["description"] or ""
                cat = r["category"] or ""
                lang = r["language"] or "javascript"
                icon = r["icon"] or "🔢"

                data.append({
                    "id": str(r["id"]),
                    "name": title,
                    "title": title,
                    "language": lang,
                    "template": tmpl,
                    "code": tmpl,
                    "description": desc,
                    "desc": desc,
                    "category": cat,
                    "icon": icon,
                    "variables": vars_list,
                    "variables_json": raw_vars,
                    "created_at": r["created_at"] or ""
                })
            return {"status": "success", "data": data}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_GENERATORS}


@eel.expose
def save_code_generators(generators_data):
    """코드/데이터 생성기 목록 저장하기 (SQLite 트랜잭션 동기화)"""
    try:
        if not isinstance(generators_data, list):
            return {"status": "error", "message": "유효한 생성기 목록 형식이 아닙니다."}

        conn = get_db_connection()
        try:
            records = []
            active_ids = []
            for idx, gen in enumerate(generators_data):
                gid = str(gen.get("id") or "")
                if not gid:
                    continue
                active_ids.append(gid)
                title = gen.get("name") or gen.get("title", "") or ""
                language = gen.get("language", "javascript") or "javascript"
                template = gen.get("code") or gen.get("template", "") or ""
                description = gen.get("description") or gen.get("desc", "") or ""
                category = gen.get("category", "") or ""
                icon = gen.get("icon", "🔢") or "🔢"
                
                raw_vars = gen.get("variables_json") or gen.get("variables", "[]")
                if isinstance(raw_vars, (list, dict)):
                    vars_str = json.dumps(raw_vars, ensure_ascii=False)
                else:
                    vars_str = str(raw_vars) if raw_vars else "[]"
                created_at = gen.get("created_at") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                records.append((gid, title, language, template, description, category, icon, vars_str, created_at))

            with conn:
                if active_ids:
                    placeholders = ",".join("?" for _ in active_ids)
                    conn.execute(f"DELETE FROM generators WHERE id NOT IN ({placeholders})", active_ids)
                else:
                    conn.execute("DELETE FROM generators")

                if records:
                    conn.executemany("""
                        INSERT OR REPLACE INTO generators (
                            id, title, language, template, description, category, icon, variables_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)

            return {"status": "success", "message": "생성기 목록이 저장되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}
