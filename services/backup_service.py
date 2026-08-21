"""
확장 가능한 통합 데이터 백업 & 복원 (Export / Import) 서비스 모듈
새로운 기능이나 도구가 추가되어도 DATA_REGISTRY에 등록만 하면 자동으로 일괄/개별 백업 및 복원에 포함됩니다.
"""
import os
import json
import datetime
import eel

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ==========================================
# 데이터 모듈 확장성 레지스트리 (Data Module Registry)
# 새로운 데이터 파일이 추가되면 여기에 한 줄만 등록하면 됩니다.
# ==========================================
DATA_REGISTRY = {
    "shortcuts": {
        "label": "폴더 바로가기",
        "icon": "📁",
        "filename": "shortcuts.json",
        "example_filename": "shortcuts.example.json"
    },
    "quick_launch": {
        "label": "빠른 실행",
        "icon": "⚡",
        "filename": "quick_launch.json",
        "example_filename": "quick_launch.example.json"
    },
    "generators": {
        "label": "데이터 생성기",
        "icon": "🔢",
        "filename": "generators.json",
        "example_filename": "generators.example.json"
    },
    "notes": {
        "label": "빠른 메모",
        "icon": "📝",
        "filename": "notes.json",
        "example_filename": "notes.example.json"
    },
    "calendar": {
        "label": "달력 & 일정 구독",
        "icon": "📅",
        "filename": "calendar_config.json",
        "example_filename": "calendar_config.example.json"
    },
    "diagrams": {
        "label": "Mermaid 다이어그램",
        "icon": "📊",
        "filename": "diagrams.json",
        "example_filename": "diagrams.example.json"
    },
    "settings": {
        "label": "앱 설정 & UI 레이아웃",
        "icon": "⚙️",
        "filename": "app_settings.json",
        "example_filename": "app_settings.example.json"
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
    for key, meta in DATA_REGISTRY.items():
        file_path = os.path.join(base_dir, meta["filename"])
        data = _read_json_file(file_path)

        count = 0
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
            "filename": meta["filename"],
            "exists": exists,
            "item_count": count
        })
    return {"status": "success", "data": modules_info}


@eel.expose
def export_toolkit_data(selected_keys=None):
    """선택된 데이터 모듈들의 데이터를 통합 JSON 구조로 내보내기 (Export)"""
    try:
        if not selected_keys:
            selected_keys = list(DATA_REGISTRY.keys())

        export_payload = {
            "app": "Utility-Toolkit",
            "version": "1.2.0",
            "exported_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "data": {}
        }

        for key in selected_keys:
            if key in DATA_REGISTRY:
                meta = DATA_REGISTRY[key]
                file_path = os.path.join(base_dir, meta["filename"])
                content = _read_json_file(file_path)
                if content is not None:
                    export_payload["data"][key] = content

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
    통합 JSON 백업 데이터를 시스템으로 가져오기 (Import)
    - mode: 'replace' (선택된 모듈 덮어쓰기) 또는 'merge' (리스트 항목 병합)
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

        for key in selected_keys:
            if key in incoming_data and key in DATA_REGISTRY:
                meta = DATA_REGISTRY[key]
                file_path = os.path.join(base_dir, meta["filename"])
                new_data = incoming_data[key]

                try:
                    if mode == "merge" and os.path.exists(file_path):
                        existing_data = _read_json_file(file_path)
                        if isinstance(existing_data, list) and isinstance(new_data, list):
                            # ID 기준 중복 제거 병합
                            existing_ids = {str(item.get("id")) for item in existing_data if isinstance(item, dict) and "id" in item}
                            merged = list(existing_data)
                            for item in new_data:
                                if isinstance(item, dict) and "id" in item:
                                    if str(item["id"]) not in existing_ids:
                                        merged.append(item)
                                        existing_ids.add(str(item["id"]))
                                else:
                                    merged.append(item)
                            _write_json_file(file_path, merged)
                        elif isinstance(existing_data, dict) and isinstance(new_data, dict):
                            # 딕셔너리 키 병합
                            merged = dict(existing_data)
                            merged.update(new_data)
                            _write_json_file(file_path, merged)
                        else:
                            _write_json_file(file_path, new_data)
                    else:
                        # 덮어쓰기 (Replace)
                        _write_json_file(file_path, new_data)

                    restored_keys.append(key)
                except Exception as ex:
                    errors.append(f"[{meta['label']}] 복원 오류: {str(ex)}")

        return {
            "status": "success",
            "restored_keys": restored_keys,
            "errors": errors,
            "message": f"총 {len(restored_keys)}개의 데이터 모듈이 성공적으로 복원되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"가져오기 실패: {str(e)}"}
