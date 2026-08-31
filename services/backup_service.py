"""
확장 가능한 통합 데이터 백업 & 복원 (Export / Import) 서비스 모듈 (services/backup_service.py)
- Python 백엔드 디스크 직접 파일 I/O 기반의 Zero-Memory 백업 & 복원 아키텍처
- 브라우저 V8 힙 메모리 적재 없이 수만 건의 레코드를 SQLite DB로 초고속 배치(Batch) 복원
- JSON 및 ZIP 압축 백업 포맷 완벽 지원
- 타 PC 및 버전 간 이동성/호환성 100% 보장
"""
import os
import io
import json
import zipfile
import datetime
import eel
from core.paths import APP_DIR, BUNDLE_DIR, DATA_DIR, DB_PATH
from services.db_service import get_db_connection
import core.logger

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


def _format_file_size(size_in_bytes: int) -> str:
    """바이트 크기를 사람이 읽기 쉬운 단위로 변환"""
    if size_in_bytes < 1024:
        return f"{size_in_bytes} B"
    elif size_in_bytes < 1024 * 1024:
        return f"{size_in_bytes / 1024:.1f} KB"
    else:
        return f"{size_in_bytes / (1024 * 1024):.1f} MB"


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


def _build_export_payload(selected_keys):
    """선택된 모듈들의 데이터를 추출하여 통합 딕셔너리 생성"""
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

    return export_payload


@eel.expose
def export_toolkit_data(selected_keys=None):
    """
    [하위 호환 및 클립보드 복사용]
    선택된 데이터 모듈들의 데이터를 통합 JSON 구조로 인메모리 반환
    """
    try:
        payload = _build_export_payload(selected_keys)
        return {
            "status": "success",
            "payload": payload,
            "filename": f"utility-toolkit-backup-{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        }
    except Exception as e:
        core.logger.log_error("Backup", f"내보내기 데이터 생성 실패: {e}", exc=e)
        return {"status": "error", "message": str(e)}


@eel.expose
def export_toolkit_to_file(selected_keys=None, preferred_format="json"):
    """
    [Zero-Memory 백엔드 직접 파일 저장]
    OS 파일 저장 대화상자를 열어 사용자가 선택한 경로에 JSON 또는 ZIP 백업을 직접 디스크에 기록
    - 브라우저 WebSocket으로 수십 MB의 데이터를 전송하지 않으므로 메모리 부하 0
    """
    try:
        import tkinter as tk
        from tkinter import filedialog

        if not selected_keys:
            selected_keys = list(DATA_REGISTRY.keys())

        now_str = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        default_name = f"utility-toolkit-backup-{now_str}.json"

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        save_path = filedialog.asksaveasfilename(
            title="통합 백업 파일 저장 위치 선택",
            initialfile=default_name,
            defaultextension=".json",
            filetypes=[
                ("JSON 백업 파일 (*.json)", "*.json"),
                ("ZIP 압축 백업 파일 (*.zip)", "*.zip"),
                ("모든 파일 (*.*)", "*.*")
            ]
        )
        root.destroy()

        if not save_path:
            return {"status": "cancelled"}

        save_path = os.path.normpath(save_path)
        payload = _build_export_payload(selected_keys)

        is_zip = save_path.lower().endswith(".zip")
        if is_zip:
            json_text = json.dumps(payload, ensure_ascii=False, indent=2)
            with zipfile.ZipFile(save_path, 'w', compression=zipfile.ZIP_DEFLATED) as zipf:
                zipf.writestr(f"backup-{now_str}.json", json_text)
        else:
            with open(save_path, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)

        file_size = os.path.getsize(save_path)
        size_str = _format_file_size(file_size)
        file_name = os.path.basename(save_path)

        core.logger.log_info("Backup", f"백업 파일 저장 완료 ({len(selected_keys)}개 모듈, {size_str}) -> {save_path}")

        return {
            "status": "success",
            "file_path": save_path,
            "file_name": file_name,
            "file_size": file_size,
            "file_size_str": size_str,
            "module_count": len(selected_keys)
        }
    except Exception as e:
        core.logger.log_error("Backup", f"백업 파일 저장 실패: {e}", exc=e)
        return {"status": "error", "message": f"백업 파일 저장 실패: {str(e)}"}


@eel.expose
def pick_backup_file_and_get_summary():
    """
    [Zero-Memory 백엔드 파일 열기 및 요약 분석]
    OS 탐색기에서 백업 파일(.json 또는 .zip)을 선택하여 디스크에서 직접 파싱하고,
    브라우저에는 오직 '모듈별 요약 정보(이름, 아이콘, 항목 수)'만 반환
    """
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_path = filedialog.askopenfilename(
            title="복원할 백업 파일(.json 또는 .zip) 선택",
            filetypes=[
                ("백업 파일 (*.json;*.zip)", "*.json;*.zip"),
                ("JSON 백업 파일 (*.json)", "*.json"),
                ("ZIP 압축 백업 파일 (*.zip)", "*.zip"),
                ("모든 파일 (*.*)", "*.*")
            ]
        )
        root.destroy()

        if not file_path:
            return {"status": "cancelled"}

        file_path = os.path.normpath(file_path)
        file_size = os.path.getsize(file_path)
        file_name = os.path.basename(file_path)
        size_str = _format_file_size(file_size)

        incoming_data = None
        exported_at = "알 수 없음"

        # ZIP 파일 또는 JSON 파일 읽기
        if file_path.lower().endswith(".zip"):
            with zipfile.ZipFile(file_path, 'r') as zipf:
                json_files = [name for name in zipf.namelist() if name.endswith('.json')]
                if not json_files:
                    return {"status": "error", "message": "ZIP 파일 내에 JSON 백업 데이터가 존재하지 않습니다."}
                with zipf.open(json_files[0]) as zf:
                    parsed = json.load(zf)
                    incoming_data = parsed.get("data", {})
                    exported_at = parsed.get("exported_at", exported_at)
        else:
            with open(file_path, 'r', encoding='utf-8') as f:
                parsed = json.load(f)
                if not isinstance(parsed, dict) or "data" not in parsed:
                    return {"status": "error", "message": "유효한 Utility Toolkit 백업 JSON 형식이 아닙니다 (data 필드 없음)."}
                incoming_data = parsed.get("data", {})
                exported_at = parsed.get("exported_at", exported_at)

        if not incoming_data or not isinstance(incoming_data, dict):
            return {"status": "error", "message": "백업 파일 내에 복원 가능한 데이터 모듈이 없습니다."}

        # 브라우저 UI 표시용 가벼운 요약 메타데이터 생성 (대용량 레코드 본문은 전송하지 않음!)
        modules_summary = []
        for key, val in incoming_data.items():
            reg_meta = DATA_REGISTRY.get(key, {"label": key, "icon": "📦"})
            count_str = ""
            if isinstance(val, list):
                count_str = f"{len(val)}개 항목"
            elif isinstance(val, dict):
                if key == "calendar" and "ics_urls" in val:
                    count_str = f"{len(val['ics_urls'])}개 구독"
                else:
                    count_str = f"{len(val.keys())}개 설정"
            else:
                count_str = "1개 데이터"

            modules_summary.append({
                "key": key,
                "label": reg_meta.get("label", key),
                "icon": reg_meta.get("icon", "📦"),
                "count_str": count_str,
                "exists_in_registry": key in DATA_REGISTRY
            })

        core.logger.log_info("Backup", f"백업 파일 로드 및 분석 완료 ({len(modules_summary)}개 모듈, {size_str}) -> {file_name}")

        return {
            "status": "success",
            "file_path": file_path,
            "file_name": file_name,
            "file_size": file_size,
            "file_size_str": size_str,
            "exported_at": exported_at,
            "modules": modules_summary
        }
    except Exception as e:
        core.logger.log_error("Backup", f"백업 파일 로드 실패: {e}", exc=e)
        return {"status": "error", "message": f"백업 파일 읽기 실패: {str(e)}"}


def _execute_restore_payload(incoming_data, selected_keys=None, mode="replace"):
    """
    통합 딕셔너리 데이터를 SQLite DB 및 설정 파일로 배치 복원 실행
    """
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
                                    item.get("sync_scope", "all_open"),
                                    item.get("sync_limit", 300),
                                    item.get("sync_project_id", 0),
                                    item.get("updated_at", "")
                                ))
                            conn.executemany("""
                                INSERT OR REPLACE INTO redmine_config (
                                    id, server_url, api_key, user_id, user_name, user_login,
                                    auto_sync, sync_interval_min, sync_scope, sync_limit, sync_project_id, updated_at
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    return restored_keys, errors


@eel.expose
def restore_toolkit_from_file(file_path: str, selected_keys: list = None, mode: str = "replace"):
    """
    [Zero-Memory 백엔드 파일 직접 복원]
    디스크의 백업 파일(.json 또는 .zip)에서 직접 읽어 SQLite DB 및 설정 파일로 고속 복원
    """
    try:
        if not os.path.exists(file_path):
            return {"status": "error", "message": f"파일을 찾을 수 없습니다: {file_path}"}

        incoming_data = None
        if file_path.lower().endswith(".zip"):
            with zipfile.ZipFile(file_path, 'r') as zipf:
                json_files = [name for name in zipf.namelist() if name.endswith('.json')]
                if not json_files:
                    return {"status": "error", "message": "ZIP 파일 내에 JSON 백업 데이터가 존재하지 않습니다."}
                with zipf.open(json_files[0]) as zf:
                    parsed = json.load(zf)
                    incoming_data = parsed.get("data", {})
        else:
            with open(file_path, 'r', encoding='utf-8') as f:
                parsed = json.load(f)
                incoming_data = parsed.get("data", {})

        if not incoming_data:
            return {"status": "error", "message": "복원할 유효한 데이터가 없습니다."}

        restored_keys, errors = _execute_restore_payload(incoming_data, selected_keys, mode)

        core.logger.log_info("Backup", f"데이터 파일 복원 완료 (총 {len(restored_keys)}개 모듈, 방식: {mode}) <- {os.path.basename(file_path)}")

        return {
            "status": "success",
            "restored_keys": restored_keys,
            "errors": errors,
            "message": f"총 {len(restored_keys)}개의 데이터 모듈이 디스크에서 안전하게 복원되었습니다."
        }
    except Exception as e:
        core.logger.log_error("Backup", f"파일 기반 복원 실패: {e}", exc=e)
        return {"status": "error", "message": f"복원 실패: {str(e)}"}


@eel.expose
def import_toolkit_data(import_payload, selected_keys=None, mode="replace"):
    """
    [기존 호환용 인메모리 / 텍스트 붙여넣기 복원]
    통합 JSON 백업 데이터를 SQLite DB 및 설정 파일로 가져오기
    """
    try:
        if isinstance(import_payload, str):
            import_payload = json.loads(import_payload)

        if not isinstance(import_payload, dict) or "data" not in import_payload:
            return {"status": "error", "message": "유효한 Utility Toolkit 백업 JSON 형식이 아닙니다."}

        incoming_data = import_payload["data"]
        restored_keys, errors = _execute_restore_payload(incoming_data, selected_keys, mode)

        core.logger.log_info("Backup", f"텍스트 기반 데이터 복원 완료 (총 {len(restored_keys)}개 모듈)")

        return {
            "status": "success",
            "restored_keys": restored_keys,
            "errors": errors,
            "message": f"총 {len(restored_keys)}개의 데이터 모듈이 성공적으로 복원되었습니다."
        }
    except Exception as e:
        core.logger.log_error("Backup", f"가져오기 실패: {e}", exc=e)
        return {"status": "error", "message": f"가져오기 실패: {str(e)}"}
