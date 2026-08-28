"""
확장 가능한 통합 데이터 백업 & 복원 (Export / Import) 서비스 모듈
- SQLite 중앙 DB(data/app.db)와 파일 기반 설정(캘린더, 설정)을 일괄/개별 백업 및 복원
- JSON 백업 파일 포맷을 유지하여 타 PC 및 버전 간 이동성/호환성 100% 보장
"""
import os
import json
import datetime
import eel
from core.paths import APP_DIR, BUNDLE_DIR
from services.db_service import get_db_connection

base_dir = APP_DIR

# ==========================================
# 데이터 모듈 확장성 레지스트리 (Data Module Registry)
# ==========================================
DATA_REGISTRY = {
    "shortcuts": {
        "label": "폴더 바로가기",
        "icon": "📁",
        "type": "sqlite",
        "table": "shortcuts"
    },
    "quick_launch": {
        "label": "빠른 실행",
        "icon": "⚡",
        "type": "sqlite",
        "table": "quick_launch"
    },
    "generators": {
        "label": "데이터 생성기",
        "icon": "🔢",
        "type": "sqlite",
        "table": "generators"
    },
    "notes": {
        "label": "빠른 메모",
        "icon": "📝",
        "type": "sqlite",
        "table": "notes"
    },
    "diagrams": {
        "label": "Mermaid 다이어그램",
        "icon": "📊",
        "type": "sqlite",
        "table": "diagrams"
    },
    "emails": {
        "label": "이메일 아카이브",
        "icon": "📧",
        "type": "sqlite",
        "table": "emails"
    },
    "mock_templates": {
        "label": "모의 데이터 양식",
        "icon": "🎲",
        "type": "sqlite",
        "table": "mock_templates"
    },
    "calendar": {
        "label": "달력 & 일정 구독",
        "icon": "📅",
        "type": "json",
        "filename": "calendar_config.json"
    },
    "settings": {
        "label": "앱 설정 & UI 레이아웃",
        "icon": "⚙️",
        "type": "json",
        "filename": "app_settings.json"
    },
    "redmine_config": {
        "label": "Redmine 연동 설정",
        "icon": "🦊",
        "type": "sqlite",
        "table": "redmine_config"
    }
}


def _read_json_file(file_path):
    """안전한 JSON 파일 읽기"""
    if os.path.exists(file_path):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None
    return None


def _write_json_file(file_path, data):
    """안전한 JSON 파일 쓰기"""
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@eel.expose
def get_registered_backup_modules():
    """현재 등록된 모든 데이터 모듈 정보 및 각 모듈별 저장 항목 수 반환"""
    modules_info = []
    conn = None
    try:
        conn = get_db_connection()
    except Exception:
        conn = None

    for key, meta in DATA_REGISTRY.items():
        count = 0
        exists = False

        if meta.get("type") == "sqlite" and conn:
            try:
                table = meta["table"]
                row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
                if row:
                    count = row[0]
                    exists = count > 0
            except Exception:
                count = 0
        else:
            filename = meta.get("filename", f"{key}.json")
            file_path = os.path.join(base_dir, filename)
            data = _read_json_file(file_path)
            exists = os.path.exists(file_path)
            if data is not None:
                if isinstance(data, list):
                    count = len(data)
                elif isinstance(data, dict):
                    if key == "calendar" and "ics_urls" in data:
                        count = len(data["ics_urls"])
                    else:
                        count = len(data.keys())

        modules_info.append({
            "key": key,
            "label": meta["label"],
            "icon": meta["icon"],
            "filename": meta.get("filename", f"{key} (SQLite DB)"),
            "exists": exists,
            "item_count": count
        })

    if conn:
        try:
            conn.close()
        except Exception:
            pass

    return {"status": "success", "data": modules_info}


@eel.expose
def export_toolkit_data(selected_keys=None):
    """선택된 데이터 모듈들의 데이터를 통합 JSON 구조로 내보내기 (Export)"""
    try:
        if not selected_keys:
            selected_keys = list(DATA_REGISTRY.keys())

        export_payload = {
            "app": "Utility-Toolkit",
            "version": "2.0.0",
            "exported_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "data": {}
        }

        conn = get_db_connection()
        try:
            for key in selected_keys:
                if key not in DATA_REGISTRY:
                    continue
                meta = DATA_REGISTRY[key]

                if meta.get("type") == "sqlite":
                    table = meta["table"]
                    cursor = conn.cursor()
                    rows = cursor.execute(f"SELECT * FROM {table}").fetchall()
                    records = []
                    for r in rows:
                        d = dict(r)
                        # attachments_json 등 JSON 필드는 객체로 변환
                        if "attachments_json" in d:
                            try:
                                d["attachments"] = json.loads(d.pop("attachments_json") or "[]")
                            except Exception:
                                d["attachments"] = []
                        if "variables_json" in d:
                            try:
                                d["variables"] = json.loads(d.pop("variables_json") or "[]")
                            except Exception:
                                d["variables"] = []
                        if "schema_json" in d:
                            try:
                                d["schema"] = json.loads(d.pop("schema_json") or "[]")
                            except Exception:
                                d["schema"] = []
                        records.append(d)
                    export_payload["data"][key] = records
                else:
                    file_path = os.path.join(base_dir, meta["filename"])
                    content = _read_json_file(file_path)
                    if content is not None:
                        export_payload["data"][key] = content
        finally:
            conn.close()

        return {
            "status": "success",
            "payload": export_payload,
            "filename": f"utility-toolkit-backup-{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def import_toolkit_data(import_payload, selected_keys=None, mode="replace"):
    """
    통합 JSON 백업 데이터를 SQLite DB 및 설정 파일로 가져오기 (Import)
    - mode: 'replace' (선택된 모듈 덮어쓰기) 또는 'merge' (기존 데이터 유지하며 신규 병합)
    """
    try:
        if isinstance(import_payload, str):
            import_payload = json.loads(import_payload)

        if not isinstance(import_payload, dict) or "data" not in import_payload:
            return {"status": "error", "message": "유효한 Utility Toolkit 백업 JSON 형식이 아닙니다."}

        incoming_data = import_payload["data"]
        if not selected_keys:
            selected_keys = list(incoming_data.keys())

        restored_keys = []
        errors = []

        conn = get_db_connection()
        try:
            for key in selected_keys:
                if key not in incoming_data or key not in DATA_REGISTRY:
                    continue
                meta = DATA_REGISTRY[key]
                new_data = incoming_data[key]

                try:
                    if meta.get("type") == "sqlite":
                        table = meta["table"]
                        if not isinstance(new_data, list):
                            continue

                        with conn:
                            if mode == "replace":
                                conn.execute(f"DELETE FROM {table}")

                            # 테이블별 적절한 필드 매핑 및 INSERT
                            if table == "notes":
                                records = []
                                for item in new_data:
                                    records.append((
                                        str(item.get("id", "")),
                                        item.get("title", ""),
                                        item.get("content", ""),
                                        item.get("category", ""),
                                        item.get("color", ""),
                                        1 if item.get("is_pinned") else 0,
                                        item.get("created_at", ""),
                                        item.get("updated_at") or item.get("updatedAt", "")
                                    ))
                                conn.executemany("""
                                    INSERT OR REPLACE INTO notes (id, title, content, category, color, is_pinned, created_at, updated_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                """, records)

                            elif table == "diagrams":
                                records = []
                                for item in new_data:
                                    records.append((
                                        str(item.get("id", "")),
                                        item.get("title", ""),
                                        item.get("code", ""),
                                        item.get("category", ""),
                                        item.get("type", ""),
                                        item.get("description", ""),
                                        item.get("created_at", ""),
                                        item.get("updated_at") or item.get("updatedAt", "")
                                    ))
                                conn.executemany("""
                                    INSERT OR REPLACE INTO diagrams (id, title, code, category, type, description, created_at, updated_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                """, records)

                            elif table == "quick_launch":
                                records = []
                                for idx, item in enumerate(new_data):
                                    records.append((
                                        str(item.get("id", "")),
                                        item.get("title") or item.get("name", ""),
                                        item.get("path") or item.get("command", ""),
                                        item.get("icon", "⚡"),
                                        item.get("category") or item.get("type", "cmd"),
                                        item.get("description") or item.get("desc", ""),
                                        int(item.get("order_index", idx)),
                                        item.get("created_at", "")
                                    ))
                                conn.executemany("""
                                    INSERT OR REPLACE INTO quick_launch (id, title, path, icon, category, description, order_index, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                """, records)

                            elif table == "shortcuts":
                                records = []
                                for item in new_data:
                                    records.append((
                                        str(item.get("id", "")),
                                        item.get("title") or item.get("name", ""),
                                        item.get("key_combo", ""),
                                        item.get("url_or_path") or item.get("path", ""),
                                        item.get("category", "folder"),
                                        item.get("description") or item.get("desc", ""),
                                        item.get("icon", "📁"),
                                        item.get("created_at", "")
                                    ))
                                conn.executemany("""
                                    INSERT OR REPLACE INTO shortcuts (id, title, key_combo, url_or_path, category, description, icon, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                """, records)

                            elif table == "generators":
                                records = []
                                for item in new_data:
                                    raw_vars = item.get("variables_json") or item.get("variables", "[]")
                                    vars_str = json.dumps(raw_vars, ensure_ascii=False) if isinstance(raw_vars, (list, dict)) else str(raw_vars)
                                    records.append((
                                        str(item.get("id", "")),
                                        item.get("title") or item.get("name", ""),
                                        item.get("language", "javascript"),
                                        item.get("template") or item.get("code", ""),
                                        item.get("description") or item.get("desc", ""),
                                        item.get("category", ""),
                                        item.get("icon", "🔢"),
                                        vars_str,
                                        item.get("created_at", "")
                                    ))
                                conn.executemany("""
                                    INSERT OR REPLACE INTO generators (id, title, language, template, description, category, icon, variables_json, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """, records)

                            elif table == "emails":
                                records = []
                                for item in new_data:
                                    raw_att = item.get("attachments_json") or item.get("attachments", "[]")
                                    att_str = json.dumps(raw_att, ensure_ascii=False) if isinstance(raw_att, (list, dict)) else str(raw_att)
                                    records.append((
                                        str(item.get("id", "")),
                                        item.get("subject", "(제목 없음)"),
                                        item.get("clean_subject", ""),
                                        item.get("thread_key", ""),
                                        item.get("from_addr") or item.get("from", ""),
                                        item.get("to_addr") or item.get("to", ""),
                                        item.get("date_str") or item.get("date", ""),
                                        item.get("category", "기타"),
                                        item.get("snippet", ""),
                                        item.get("body_text", ""),
                                        item.get("body_html", ""),
                                        att_str,
                                        item.get("message_id", ""),
                                        item.get("in_reply_to", ""),
                                        item.get("references_header") or item.get("references", ""),
                                        item.get("file_path", ""),
                                        item.get("created_at", "")
                                    ))
                                conn.executemany("""
                                    INSERT OR REPLACE INTO emails (
                                        id, subject, clean_subject, thread_key,
                                        from_addr, to_addr, date_str, category,
                                        snippet, body_text, body_html, attachments_json,
                                        message_id, in_reply_to, references_header,
                                        file_path, created_at
                                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """, records)

                            elif table == "mock_templates":
                                records = []
                                for item in new_data:
                                    raw_schema = item.get("schema_json") or item.get("schema", "[]")
                                    schema_str = json.dumps(raw_schema, ensure_ascii=False) if isinstance(raw_schema, (list, dict)) else str(raw_schema)
                                    records.append((
                                        str(item.get("id", "")),
                                        item.get("title", ""),
                                        item.get("description", ""),
                                        item.get("icon", "⭐"),
                                        schema_str,
                                        item.get("created_at", ""),
                                        item.get("updated_at") or item.get("created_at", "")
                                    ))
                                conn.executemany("""
                                    INSERT OR REPLACE INTO mock_templates (
                                        id, title, description, icon, schema_json, created_at, updated_at
                                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                                """, records)

                            elif table == "redmine_config":
                                records = []
                                for item in new_data:
                                    records.append((
                                        str(item.get("id", "default")),
                                        item.get("server_url", ""),
                                        item.get("api_key", ""),
                                        item.get("user_id"),
                                        item.get("user_name", ""),
                                        item.get("user_login", ""),
                                        item.get("auto_sync", 1),
                                        item.get("sync_interval_min", 5),
                                        item.get("updated_at", "")
                                    ))
                                conn.executemany("""
                                    INSERT OR REPLACE INTO redmine_config (
                                        id, server_url, api_key, user_id, user_name, user_login,
                                        auto_sync, sync_interval_min, updated_at
                                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """, records)

                        restored_keys.append(key)
                    else:
                        # JSON 파일 복원
                        file_path = os.path.join(base_dir, meta["filename"])
                        if mode == "merge" and os.path.exists(file_path):
                            existing = _read_json_file(file_path)
                            if isinstance(existing, dict) and isinstance(new_data, dict):
                                merged = dict(existing)
                                merged.update(new_data)
                                _write_json_file(file_path, merged)
                            else:
                                _write_json_file(file_path, new_data)
                        else:
                            _write_json_file(file_path, new_data)
                        restored_keys.append(key)

                except Exception as ex:
                    errors.append(f"[{meta['label']}] 복원 오류: {str(ex)}")

        finally:
            conn.close()

        return {
            "status": "success",
            "restored_keys": restored_keys,
            "errors": errors,
            "message": f"총 {len(restored_keys)}개의 데이터 모듈이 성공적으로 복원되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"가져오기 실패: {str(e)}"}
