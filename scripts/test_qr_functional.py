"""
QR Toolkit 백엔드 기능 테스트 (scripts/test_qr_functional.py)
- services.qr_service의 주요 알고리즘 및 API 기능 전수 검증
- 100% 자동화 단위/기능 테스트
"""

import sys
from pathlib import Path

# 루트 디렉토리 sys.path 추가
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from services.db_service import init_db, get_db_connection
from services.qr_service import (
    _detect_format_type,
    parse_qr_data,
    save_qr_history,
    get_qr_history,
    delete_qr_history,
    clear_qr_history,
    open_external_url
)


def test_format_type_detection():
    print("[RUN] test_format_type_detection...")
    # 1. URL 감지
    res = _detect_format_type("https://github.com/google/gemini")
    assert res["format_type"] == "url"
    assert res["parsed_data"]["url"] == "https://github.com/google/gemini"

    # 2. Wi-Fi 감지
    wifi_str = "WIFI:T:WPA;S:MyHomeWiFi;P:secret1234;H:false;;"
    res = _detect_format_type(wifi_str)
    assert res["format_type"] == "wifi"
    assert res["parsed_data"]["ssid"] == "MyHomeWiFi"
    assert res["parsed_data"]["password"] == "secret1234"
    assert res["parsed_data"]["auth_type"] == "WPA"

    # 3. Email 감지
    email_str = "mailto:test@example.com?subject=Hello"
    res = _detect_format_type(email_str)
    assert res["format_type"] == "email"
    assert res["parsed_data"]["email"] == "test@example.com"

    # 4. Tel 감지
    tel_str = "tel:010-1234-5678"
    res = _detect_format_type(tel_str)
    assert res["format_type"] == "tel"
    assert res["parsed_data"]["phone"] == "010-1234-5678"

    # 5. vCard 감지
    vcard_str = "BEGIN:VCARD\nVERSION:3.0\nFN:Hong Gildong\nTEL:010-9999-8888\nEMAIL:hong@example.com\nORG:Company\nEND:VCARD"
    res = _detect_format_type(vcard_str)
    assert res["format_type"] == "vcard"
    assert res["parsed_data"]["name"] == "Hong Gildong"
    assert res["parsed_data"]["phone"] == "010-9999-8888"

    # 6. 일반 텍스트
    plain = "Just plain sample text"
    res = _detect_format_type(plain)
    assert res["format_type"] == "text"
    assert res["parsed_data"]["text"] == plain

    print("  [PASS] test_format_type_detection")


def test_qr_history_crud():
    print("[RUN] test_qr_history_crud...")
    init_db()

    # 1. 초기 비우기 (테스트 격리)
    clear_qr_history()

    # 2. 스캔 이력 저장
    res1 = save_qr_history("scan", "https://antigravity.dev", "Antigravity Dev")
    assert res1["status"] == "success"
    assert res1["action_type"] == "scan"
    assert res1["format_type"] == "url"
    id1 = res1["id"]

    # 3. 생성 이력 저장
    res2 = save_qr_history("generate", "WIFI:T:WPA;S:OfficeNet;P:pass123;;", "OfficeNet WiFi")
    assert res2["status"] == "success"
    assert res2["action_type"] == "generate"
    assert res2["format_type"] == "wifi"
    id2 = res2["id"]

    # 4. 조회
    hist = get_qr_history(limit=10)
    assert hist["status"] == "success"
    assert len(hist["items"]) == 2
    assert hist["items"][0]["id"] == id2  # 최신순
    assert hist["items"][1]["id"] == id1

    # 5. 검색
    search_res = get_qr_history(search="antigravity")
    assert search_res["status"] == "success"
    assert len(search_res["items"]) == 1
    assert search_res["items"][0]["id"] == id1

    # 6. 단건 삭제
    del_res = delete_qr_history(id1)
    assert del_res["status"] == "success"
    hist_after = get_qr_history()
    assert len(hist_after["items"]) == 1
    assert hist_after["items"][0]["id"] == id2

    # 7. 전체 삭제
    clear_res = clear_qr_history()
    assert clear_res["status"] == "success"
    hist_empty = get_qr_history()
    assert len(hist_empty["items"]) == 0

    print("  [PASS] test_qr_history_crud")


def test_open_external_url_validation():
    print("[RUN] test_open_external_url_validation...")
    # 프로토콜 검증 테스트
    invalid_res = open_external_url("javascript:alert(1)")
    assert invalid_res["status"] == "error"

    empty_res = open_external_url("")
    assert empty_res["status"] == "error"

    file_res = open_external_url("file:///etc/passwd")
    assert file_res["status"] == "error"

    print("  [PASS] test_open_external_url_validation")


if __name__ == "__main__":
    print("=" * 60)
    print("  Running QR Toolkit Functional Tests")
    print("=" * 60)
    test_format_type_detection()
    test_qr_history_crud()
    test_open_external_url_validation()
    print("=" * 60)
    print("  All QR Functional Tests Passed Successfully!")
    print("=" * 60)
