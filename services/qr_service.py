"""
services/qr_service.py - QR 코드 스캐너 & 생성기 통합 백엔드 서비스 모듈
- SQLite DB(qr_history 테이블) 기반 스캔 및 생성 이력 관리
- 브라우저 기본 웹 브라우저 외부 링크 열기 (webbrowser)
- 텍스트/Wi-Fi/연락처/URL 등 포맷 유형 자동 분석 및 파싱
- 생성된 QR 이미지 로컬 파일 저장 대화상자 지원
"""

import os
import re
import base64
import webbrowser
from typing import Dict, Any, List, Optional
import eel
from services.db_service import get_db_connection
from core.logger import log_event


def _detect_format_type(content: str) -> Dict[str, Any]:
    """QR 코드 내용의 포맷 유형(URL, Wi-Fi, Email, Tel, vCard, 일반 텍스트) 분석"""
    if not content:
        return {"format_type": "text", "parsed_data": {}}

    trimmed = content.strip()

    # 1. URL 감지
    url_pattern = re.compile(r'^(https?://|ftp://)[^\s/$.?#].[^\s]*$', re.IGNORECASE)
    if url_pattern.match(trimmed) or trimmed.startswith(("http://", "https://")):
        return {
            "format_type": "url",
            "parsed_data": {"url": trimmed}
        }

    # 2. Wi-Fi 포맷 감지: WIFI:T:WPA;S:MySSID;P:MyPassword;H:false;;
    if trimmed.startswith("WIFI:"):
        auth_type_match = re.search(r'T:([^;]*);?', trimmed)
        ssid_match = re.search(r'S:([^;]*);?', trimmed)
        pwd_match = re.search(r'P:([^;]*);?', trimmed)
        hidden_match = re.search(r'H:([^;]*);?', trimmed)

        return {
            "format_type": "wifi",
            "parsed_data": {
                "auth_type": auth_type_match.group(1) if auth_type_match else "WPA",
                "ssid": ssid_match.group(1) if ssid_match else "",
                "password": pwd_match.group(1) if pwd_match else "",
                "hidden": hidden_match.group(1).lower() in ("true", "1") if hidden_match else False
            }
        }

    # 3. 메일(mailto:) 감지
    if trimmed.lower().startswith("mailto:"):
        email_addr = trimmed[7:].split("?")[0]
        return {
            "format_type": "email",
            "parsed_data": {"email": email_addr, "raw": trimmed}
        }

    # 4. 전화번호(tel:) 감지
    if trimmed.lower().startswith("tel:"):
        phone_num = trimmed[4:].strip()
        return {
            "format_type": "tel",
            "parsed_data": {"phone": phone_num}
        }

    # 5. vCard(명함) 감지
    if "BEGIN:VCARD" in trimmed.upper():
        name_match = re.search(r'\nFN:(.*?)\r?\n', trimmed, re.IGNORECASE)
        tel_match = re.search(r'\nTEL[^:]*:(.*?)\r?\n', trimmed, re.IGNORECASE)
        email_match = re.search(r'\nEMAIL[^:]*:(.*?)\r?\n', trimmed, re.IGNORECASE)
        org_match = re.search(r'\nORG:(.*?)\r?\n', trimmed, re.IGNORECASE)

        return {
            "format_type": "vcard",
            "parsed_data": {
                "name": name_match.group(1).strip() if name_match else "",
                "phone": tel_match.group(1).strip() if tel_match else "",
                "email": email_match.group(1).strip() if email_match else "",
                "org": org_match.group(1).strip() if org_match else ""
            }
        }

    return {"format_type": "text", "parsed_data": {"text": trimmed}}


@eel.expose
def open_external_url(url: str) -> Dict[str, Any]:
    """기본 웹 브라우저에서 외부 링크 열기"""
    try:
        if not url:
            return {"status": "error", "message": "URL이 비어 있습니다."}

        trimmed = url.strip()
        # 안전한 프로토콜(http, https) 검증
        if not (trimmed.startswith("http://") or trimmed.startswith("https://") or trimmed.startswith("mailto:")):
            return {"status": "error", "message": "허용되지 않은 프로토콜입니다."}

        webbrowser.open(trimmed)
        log_event("info", "QR", f"브라우저 링크 열기: {trimmed[:60]}")
        return {"status": "success", "url": trimmed}
    except Exception as e:
        log_event("error", "QR", f"브라우저 링크 열기 실패: {str(e)}")
        return {"status": "error", "message": str(e)}


@eel.expose
def parse_qr_data(content: str) -> Dict[str, Any]:
    """QR 코드 내용의 포맷 유형 및 상세 정보 분석"""
    try:
        result = _detect_format_type(content)
        return {"status": "success", **result}
    except Exception as e:
        return {"status": "error", "message": str(e), "format_type": "text", "parsed_data": {}}


@eel.expose
def save_qr_history(action_type: str, content: str, title: str = "", format_type: str = "") -> Dict[str, Any]:
    """QR 스캔 또는 생성 이력을 SQLite DB에 저장"""
    try:
        if not content:
            return {"status": "error", "message": "내용이 없습니다."}

        # format_type 자동 감지
        if not format_type:
            detected = _detect_format_type(content)
            format_type = detected.get("format_type", "text")

        # title 미지정 시 내용 기반 요약 생성
        if not title:
            first_line = content.strip().splitlines()[0]
            title = (first_line[:40] + "...") if len(first_line) > 40 else first_line

        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO qr_history (action_type, content, title, format_type)
                VALUES (?, ?, ?, ?)
            """, (action_type, content, title, format_type))
            conn.commit()
            item_id = cursor.lastrowid
            return {
                "status": "success",
                "id": item_id,
                "action_type": action_type,
                "content": content,
                "title": title,
                "format_type": format_type
            }
        finally:
            conn.close()
    except Exception as e:
        log_event("error", "QR", f"이력 저장 실패: {str(e)}")
        return {"status": "error", "message": str(e)}


@eel.expose
def get_qr_history(limit: int = 50, search: str = "") -> Dict[str, Any]:
    """QR 이력 목록 조회"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            if search:
                term = f"%{search}%"
                cursor.execute("""
                    SELECT id, action_type, content, title, format_type, created_at
                    FROM qr_history
                    WHERE content LIKE ? OR title LIKE ?
                    ORDER BY id DESC
                    LIMIT ?
                """, (term, term, limit))
            else:
                cursor.execute("""
                    SELECT id, action_type, content, title, format_type, created_at
                    FROM qr_history
                    ORDER BY id DESC
                    LIMIT ?
                """, (limit,))

            rows = cursor.fetchall()
            items = []
            for r in rows:
                items.append({
                    "id": r["id"],
                    "action_type": r["action_type"],
                    "content": r["content"],
                    "title": r["title"],
                    "format_type": r["format_type"],
                    "created_at": r["created_at"]
                })
            return {"status": "success", "items": items}
        finally:
            conn.close()
    except Exception as e:
        log_event("error", "QR", f"이력 조회 실패: {str(e)}")
        return {"status": "error", "message": str(e), "items": []}


@eel.expose
def delete_qr_history(item_id: int) -> Dict[str, Any]:
    """QR 이력 항목 단건 삭제"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM qr_history WHERE id = ?", (item_id,))
            conn.commit()
            return {"status": "success", "deleted_id": item_id}
        finally:
            conn.close()
    except Exception as e:
        log_event("error", "QR", f"이력 삭제 실패: {str(e)}")
        return {"status": "error", "message": str(e)}


@eel.expose
def clear_qr_history(action_type: Optional[str] = None) -> Dict[str, Any]:
    """QR 이력 전체(또는 특정 유형별) 비우기"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            if action_type:
                cursor.execute("DELETE FROM qr_history WHERE action_type = ?", (action_type,))
            else:
                cursor.execute("DELETE FROM qr_history")
            conn.commit()
            return {"status": "success"}
        finally:
            conn.close()
    except Exception as e:
        log_event("error", "QR", f"이력 초기화 실패: {str(e)}")
        return {"status": "error", "message": str(e)}


@eel.expose
def save_qr_image_dialog(base64_data: str, default_filename: str = "qrcode.png") -> Dict[str, Any]:
    """생성된 QR 코드 이미지를 파일 다이얼로그를 통해 저장"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        if "," in base64_data:
            base64_data = base64_data.split(",", 1)[1]

        image_bytes = base64.b64decode(base64_data)

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_path = filedialog.asksaveasfilename(
            title="QR 코드 이미지 저장",
            initialfile=default_filename,
            defaultextension=".png",
            filetypes=[("PNG Image", "*.png"), ("모든 파일", "*.*")]
        )
        root.destroy()

        if not file_path:
            return {"status": "cancelled", "path": ""}

        with open(file_path, "wb") as f:
            f.write(image_bytes)

        normalized_path = os.path.normpath(file_path)
        log_event("info", "QR", f"이미지 파일 저장 완료: {normalized_path}")
        return {"status": "success", "path": normalized_path}
    except Exception as e:
        log_event("error", "QR", f"이미지 파일 저장 실패: {str(e)}")
        return {"status": "error", "message": str(e)}
