"""
services/imap_service.py - IMAP 메일 서버 원본 EML 다운로드 및 단방향 아카이빙 서비스
- Python 내장 imaplib / ssl 기반의 무의존성 IMAP4_SSL 클라이언트
- 단방향 누적 영구 아카이브: 서버 메일 삭제/변동이 로컬에 반영되지 않음
- 중복 방지: Message-ID 및 UID 기반 신규 메일만 선별 다운로드
- 원본 RFC 822 바이트를 emails/*.eml 파일로 영구 보관 및 SQLite 인덱싱
- 다운로드 완료 즉시 AI 신경망(Multilingual-E5) 벡터 DB(ai_embeddings) 자동 임베딩
"""

import os
import sys
import ssl
import time
import uuid
import json
import imaplib
import email
import datetime
import threading
from typing import Dict, Any, List, Optional

import eel
from core.paths import APP_DIR, DATA_DIR, EMAILS_DIR
from core.logger import log_event
from services.db_service import get_db_connection
from services.email_service import _parse_eml_bytes, _ensure_emails_dir

# 전역 동기화 잠금 및 상태 플래그
_sync_lock = threading.Lock()
_is_sync_running = False
_sync_cancel_requested = False


import re


def _normalize_imap_credentials(host: str, username: str, password: str):
    """
    IMAP 접속 계정 및 비밀번호 정규화
    - 앞뒤 공백/줄바꿈 제거
    - Google 앱 비밀번호(xxxx xxxx xxxx xxxx) 복사 시 포함되는 내부 공백 자동 제거
    - Gmail/Naver/Daum 아이디만 입력한 경우 기본 도메인 보정
    """
    host_clean = (host or "").strip()
    user_clean = (username or "").strip()
    pwd_clean = (password or "").strip()

    host_lower = host_clean.lower()

    # Google 앱 비밀번호(4자리x4블록 공백 포함) 또는 Gmail 호스트인 경우 공백 제거
    if "gmail.com" in host_lower or "googlemail.com" in host_lower:
        pwd_clean = re.sub(r"\s+", "", pwd_clean)
        if user_clean and "@" not in user_clean:
            user_clean = f"{user_clean}@gmail.com"
    elif re.match(r"^[A-Za-z0-9]{4}(\s+[A-Za-z0-9]{4}){3}$", pwd_clean):
        pwd_clean = re.sub(r"\s+", "", pwd_clean)

    if "naver.com" in host_lower and user_clean and "@" not in user_clean:
        user_clean = f"{user_clean}@naver.com"
    elif "daum.net" in host_lower and user_clean and "@" not in user_clean:
        user_clean = f"{user_clean}@daum.net"

    return host_clean, user_clean, pwd_clean


def _format_imap_error(err: Exception, host: str = "") -> str:
    """imaplib 바이트 에러 메시지를 가독성 높은 한국어 원인 안내로 변환"""
    raw = str(err)
    if hasattr(err, "args") and err.args:
        first_arg = err.args[0]
        if isinstance(first_arg, bytes):
            raw = first_arg.decode("utf-8", errors="replace")
        else:
            raw = str(first_arg)

    raw_upper = raw.upper()
    if "APPLICATION-SPECIFIC PASSWORD REQUIRED" in raw_upper or "185833" in raw_upper:
        return (
            "Google 계정은 일반 비밀번호 대신 16자리 '앱 비밀번호'가 필요합니다. "
            "(Google 계정 관리 → 보안 → 2단계 인증 활성화 → '앱 비밀번호'에서 생성 후 입력)"
        )
    if "AUTHENTICATIONFAILED" in raw_upper or "INVALID CREDENTIALS" in raw_upper:
        if "gmail" in (host or "").lower():
            return (
                "인증 실패(Invalid credentials): 이메일 주소(전체 주소) 또는 16자리 Google 앱 비밀번호가 정확한지 확인해 주세요. "
                "(일반 계정 비밀번호는 사용할 수 없으며, Gmail 설정에서 IMAP이 활성화되어 있어야 합니다.)"
            )
        return (
            "인증 실패(Invalid credentials): 아이디/비밀번호가 일치하지 않거나, "
            "웹메일 환경설정에서 'IMAP/SMTP 사용'이 비활성화되어 있거나, 2단계 인증용 앱 비밀번호가 필요합니다."
        )
    return raw


import base64

_IMAP_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _decode_imap_utf7(text: str) -> str:
    """RFC 3501 IMAP Modified UTF-7 폴더명 디코딩 (예: [Gmail]/&vPSwuNO4ycDVaA- -> [Gmail]/보낸편지함)"""
    if not text or "&" not in text:
        return text

    def _replace_match(m):
        b64_part = m.group(1)
        if not b64_part:
            return "&"
        try:
            b64_std = b64_part.replace(",", "/")
            pad = (4 - len(b64_std) % 4) % 4
            raw = base64.b64decode(b64_std + ("=" * pad))
            return raw.decode("utf-16-be", errors="replace")
        except Exception:
            return m.group(0)

    return re.sub(r"&([A-Za-z0-9+,]*)-", _replace_match, text)


def _quote_imap_folder(folder: str) -> str:
    """공백이나 특수문자가 포함된 IMAP 폴더명을 안전하게 큰따옴표로 감싸기"""
    f = (folder or "INBOX").strip()
    if f.startswith('"') and f.endswith('"'):
        return f
    if any(ch in f for ch in (' ', '[', ']', '&', '/', '\\')):
        escaped = f.replace('\\', '\\\\').replace('"', '\\"')
        return f'"{escaped}"'
    return f


def _connect_imap(host: str, port: int, use_ssl: bool, timeout: int = 15):
    """IMAP 연결 인스턴스 생성"""
    if use_ssl:
        context = ssl.create_default_context()
        return imaplib.IMAP4_SSL(host, port, ssl_context=context, timeout=timeout)
    else:
        return imaplib.IMAP4(host, port, timeout=timeout)


@eel.expose
def test_imap_connection(host: str, port: int, use_ssl: bool, username: str, password: str) -> Dict[str, Any]:
    """IMAP 서버 연결 및 인증 테스트, 사서함 목록 조회"""
    try:
        host, username, password = _normalize_imap_credentials(host, username, password)
        port = int(port or 993)

        if not host or not username or not password:
            return {"status": "error", "message": "호스트 주소, 계정 및 비밀번호를 모두 입력해 주세요."}

        client = _connect_imap(host, port, use_ssl, timeout=12)
        try:
            client.login(username, password)
            status, folders_raw = client.list()
            folders = []
            has_inbox = False
            if status == "OK" and folders_raw:
                for f in folders_raw:
                    if not f:
                        continue
                    # f: b'(\\HasNoChildren) "/" "INBOX"'
                    line = f.decode('utf-8', errors='replace')
                    if "\\Noselect" in line or "\\noselect" in line.lower():
                        continue
                    parts = re.split(r'\s+"[^"]*"\s+', line, maxsplit=1)
                    if len(parts) == 2:
                        raw_name = parts[1].strip().strip('"')
                    else:
                        raw_name = line.strip()

                    if not raw_name:
                        continue
                    if raw_name.upper() == "INBOX":
                        has_inbox = True

                    decoded_label = _decode_imap_utf7(raw_name)
                    if raw_name.upper() == "INBOX":
                        display_label = "INBOX (받은편지함)"
                    elif decoded_label != raw_name:
                        display_label = f"{decoded_label} ({raw_name})"
                    else:
                        display_label = raw_name

                    folders.append({"name": raw_name, "label": display_label})

            if not has_inbox:
                folders.insert(0, {"name": "INBOX", "label": "INBOX (받은편지함)"})

            client.logout()
            return {
                "status": "success",
                "message": "IMAP 서버 연결 및 인증에 성공했습니다.",
                "folders": folders
            }
        except Exception as auth_err:
            try:
                client.logout()
            except Exception:
                pass
            friendly_msg = _format_imap_error(auth_err, host)
            log_event("warn", "IMAP", f"로그인 실패: {friendly_msg} (원본: {auth_err})")
            return {"status": "error", "message": friendly_msg}
    except Exception as conn_err:
        log_event("error", "IMAP", f"서버 연결 실패: {conn_err}")
        return {"status": "error", "message": f"서버 연결 실패: {str(conn_err)}"}


@eel.expose
def get_imap_config() -> Dict[str, Any]:
    """저장된 최신 IMAP 계정 설정 조회"""
    try:
        conn = get_db_connection()
        try:
            row = conn.execute("""
                SELECT id, account_name, host, port, use_ssl, username, password, folder, last_sync_at
                FROM imap_accounts
                ORDER BY id DESC LIMIT 1
            """).fetchone()

            if row:
                return {
                    "status": "success",
                    "config": {
                        "id": row["id"],
                        "account_name": row["account_name"],
                        "host": row["host"],
                        "port": row["port"],
                        "use_ssl": bool(row["use_ssl"]),
                        "username": row["username"],
                        "password": row["password"],
                        "folder": row["folder"] or "INBOX",
                        "last_sync_at": row["last_sync_at"] or ""
                    }
                }
            return {
                "status": "success",
                "config": {
                    "account_name": "기본 계정",
                    "host": "imap.gmail.com",
                    "port": 993,
                    "use_ssl": True,
                    "username": "",
                    "password": "",
                    "folder": "INBOX",
                    "last_sync_at": ""
                }
            }
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def save_imap_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """IMAP 계정 설정 SQLite DB 저장"""
    try:
        host, username, password = _normalize_imap_credentials(
            config.get("host") or "",
            config.get("username") or "",
            config.get("password") or ""
        )
        port = int(config.get("port") or 993)
        use_ssl = 1 if config.get("use_ssl", True) else 0
        folder = (config.get("folder") or "INBOX").strip()
        account_name = (config.get("account_name") or username or "이메일 계정").strip()

        if not host or not username:
            return {"status": "error", "message": "호스트 주소와 계정 아이디는 필수입니다."}

        conn = get_db_connection()
        try:
            row = conn.execute("SELECT id FROM imap_accounts ORDER BY id DESC LIMIT 1").fetchone()
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            if row:
                conn.execute("""
                    UPDATE imap_accounts
                    SET account_name = ?, host = ?, port = ?, use_ssl = ?, username = ?, password = ?, folder = ?, updated_at = ?
                    WHERE id = ?
                """, (account_name, host, port, use_ssl, username, password, folder, now_str, row["id"]))
            else:
                conn.execute("""
                    INSERT INTO imap_accounts (account_name, host, port, use_ssl, username, password, folder, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (account_name, host, port, use_ssl, username, password, folder, now_str, now_str))

            conn.commit()
            return {"status": "success", "message": "IMAP 설정이 저장되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def cancel_imap_sync() -> Dict[str, Any]:
    """진행 중인 IMAP 동기화 취소 요청"""
    global _sync_cancel_requested
    _sync_cancel_requested = True
    return {"status": "success"}


@eel.expose
def start_imap_sync(options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    백그라운드 스레드에서 IMAP 메일 다운로드 및 단방향 아카이빙 실행
    - options:
        - host, port, use_ssl, username, password, folder
        - since_days: 최근 N일 (None이면 전체)
        - limit: 최대 다운로드 메일 개수 (기본 100건, None이면 제한 없음)
        - auto_embed: 다운로드 후 AI 벡터 DB 즉시 임베딩 여부 (기본 True)
    """
    global _is_sync_running, _sync_cancel_requested

    if _is_sync_running:
        return {"status": "error", "message": "이미 메일 동기화가 진행 중입니다."}

    options = options or {}

    # 스레드로 비동기 실행
    worker = threading.Thread(target=_run_imap_sync_worker, args=(options,), daemon=True)
    worker.start()

    return {"status": "started", "message": "메일 다운로드 작업을 백그라운드에서 시작했습니다."}


def _run_imap_sync_worker(options: Dict[str, Any]):
    """IMAP 메일 다운로드 백그라운드 워커 함수"""
    global _is_sync_running, _sync_cancel_requested
    _is_sync_running = True
    _sync_cancel_requested = False

    _ensure_emails_dir()

    # 설정 불러오기
    host = options.get("host")
    username = options.get("username")
    password = options.get("password")
    port = int(options.get("port") or 993)
    use_ssl = bool(options.get("use_ssl", True))
    folder = options.get("folder") or "INBOX"
    since_days = options.get("since_days")  # None 또는 int
    limit = options.get("limit")  # None 또는 int
    auto_embed = options.get("auto_embed", True)

    # 파라미터가 없으면 DB에서 최신 설정 가져오기
    if not (host and username and password):
        cfg_res = get_imap_config()
        if cfg_res.get("status") == "success" and cfg_res.get("config"):
            cfg = cfg_res["config"]
            host = host or cfg.get("host")
            username = username or cfg.get("username")
            password = password or cfg.get("password")
            port = port or cfg.get("port", 993)
            use_ssl = use_ssl if "use_ssl" in options else cfg.get("use_ssl", True)
            folder = folder or cfg.get("folder", "INBOX")

    host, username, password = _normalize_imap_credentials(host or "", username or "", password or "")

    if not (host and username and password):
        _is_sync_running = False
        _notify_sync_error("IMAP 계정 설정 정보가 올바르지 않습니다.")
        return

    client = None
    try:
        _notify_sync_progress(0, 1, "IMAP 서버에 연결 중...", 0)
        client = _connect_imap(host, port, use_ssl, timeout=20)
        client.login(username, password)

        # 1. 단방향 보존 원칙: readonly=True로 열어 서버 메일 상태(플래그/삭제)를 절대 건드리지 않음
        quoted_folder = _quote_imap_folder(folder)
        status, _ = client.select(quoted_folder, readonly=True)
        if status != "OK" and folder.upper() != "INBOX":
            # 이전 테스트 등으로 존재하지 않는 폴더명이 남아있는 경우 INBOX 폴백
            log_event("warn", "IMAP", f"사서함 '{folder}' 선택 실패, 'INBOX'로 대체합니다.")
            folder = "INBOX"
            status, _ = client.select("INBOX", readonly=True)
        if status != "OK":
            raise Exception(f"사서함 '{folder}' 폴더를 선택할 수 없습니다. '폴더 조회' 버튼으로 사서함 목록을 다시 확인해 주세요.")

        # 2. 검색 조건 생성 (RFC 3501 표준 토큰 전달 및 영문 월 약어 보장)
        search_criteria = ["ALL"]
        if since_days and int(since_days) > 0:
            since_date = datetime.date.today() - datetime.timedelta(days=int(since_days))
            month_abbr = _IMAP_MONTH_NAMES[since_date.month - 1]
            date_str = f"{since_date.day:02d}-{month_abbr}-{since_date.year}"
            search_criteria = ["SINCE", date_str]

        _notify_sync_progress(0, 1, "사서함 메일 목록 조회 중...", 5)
        status, search_data = client.uid('search', None, *search_criteria)

        if status != "OK" or not search_data or not search_data[0]:
            empty_msg = "조회된 메일이 없습니다."
            if since_days and int(since_days) > 0:
                st_all, all_data = client.uid('search', None, 'ALL')
                total_in_box = len(all_data[0].split()) if (st_all == "OK" and all_data and all_data[0]) else 0
                if total_in_box > 0:
                    empty_msg = (
                        f"선택한 기간(최근 {since_days}일, {date_str} 이후) 내에 수신된 메일이 없습니다. "
                        f"(사서함 전체 메일: {total_in_box}건 — 수신 기간 범위를 '전체 기간'으로 변경하여 다시 시도해 보세요.)"
                    )
            _notify_sync_complete({
                "status": "success",
                "downloaded": 0,
                "skipped": 0,
                "embedded": 0,
                "message": empty_msg
            })
            return

        uids = search_data[0].split()
        # 최신 메일부터 받기 위해 역순 정렬
        uids.reverse()

        if limit and int(limit) > 0:
            uids = uids[:int(limit)]

        total_uids = len(uids)

        # 3. 로컬 DB에 이미 존재하는 Message-ID 목록 로드 (중복 다운로드 건너뛰기)
        existing_msg_ids = set()
        conn = get_db_connection()
        try:
            rows = conn.execute("SELECT message_id FROM emails WHERE message_id IS NOT NULL AND message_id != ''").fetchall()
            for r in rows:
                existing_msg_ids.add(r["message_id"].strip().lower())
        finally:
            conn.close()

        downloaded_count = 0
        skipped_count = 0
        downloaded_records = []

        # 4. 순차 다운로드 루프
        for idx, uid in enumerate(uids):
            if _sync_cancel_requested:
                log_event("info", "IMAP", "사용자에 의해 동기화가 취소되었습니다.")
                break

            current_no = idx + 1
            pct = int((current_no / total_uids) * 85) + 5

            try:
                # 4-1. Message-ID 헤더만 먼저 확인하여 이미 있으면 RFC822 본문 수신 생략
                uid_str = uid.decode()
                res, hdr_data = client.uid('fetch', uid, '(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])')
                msg_id_val = ""
                if res == "OK" and hdr_data and isinstance(hdr_data[0], tuple):
                    hdr_text = hdr_data[0][1].decode('utf-8', errors='replace')
                    for line in hdr_text.splitlines():
                        if line.lower().startswith("message-id:"):
                            msg_id_val = line[11:].strip().lower()
                            break

                if msg_id_val and msg_id_val in existing_msg_ids:
                    skipped_count += 1
                    _notify_sync_progress(current_no, total_uids, f"기존 보관 메일 건너뜀 (UID: {uid_str})", pct)
                    continue

                # 4-2. RFC822 원본 다운로드
                res, fetch_data = client.uid('fetch', uid, '(RFC822)')
                if res != "OK" or not fetch_data or not isinstance(fetch_data[0], tuple):
                    continue

                raw_bytes = fetch_data[0][1]
                email_id = str(uuid.uuid4())
                eml_filename = f"{email_id}.eml"
                eml_path = os.path.join(EMAILS_DIR, eml_filename)

                # 파일 영구 저장
                with open(eml_path, "wb") as f:
                    f.write(raw_bytes)

                # 메타데이터 파싱
                parsed = _parse_eml_bytes(raw_bytes, source_filename=eml_filename)
                clean_sub = parsed["clean_subject"]
                thread_key = clean_sub.lower()
                att_json = json.dumps(parsed.get("attachments", []), ensure_ascii=False)
                created_at = time.strftime("%Y-%m-%dT%H:%M:%S")

                # DB 저장
                conn = get_db_connection()
                try:
                    conn.execute("""
                        INSERT OR REPLACE INTO emails (
                            id, subject, clean_subject, thread_key,
                            from_addr, to_addr, date_str, category,
                            snippet, body_text, body_html, attachments_json,
                            message_id, in_reply_to, references_header,
                            file_path, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        email_id,
                        parsed["subject"],
                        clean_sub,
                        thread_key,
                        parsed["from"],
                        parsed["to"],
                        parsed["date"],
                        parsed["category"],
                        parsed["snippet"],
                        parsed["body_text"],
                        parsed["body_html"],
                        att_json,
                        parsed.get("message_id", ""),
                        parsed.get("in_reply_to", ""),
                        parsed.get("references", ""),
                        eml_path,
                        created_at
                    ))
                    conn.commit()
                finally:
                    conn.close()

                if parsed.get("message_id"):
                    existing_msg_ids.add(parsed["message_id"].strip().lower())

                downloaded_count += 1
                downloaded_records.append({
                    "id": email_id,
                    "subject": parsed["subject"],
                    "clean_subject": clean_sub,
                    "from": parsed["from"],
                    "to": parsed["to"],
                    "category": parsed["category"],
                    "snippet": parsed["snippet"],
                    "body_text": parsed["body_text"]
                })

                subj_preview = parsed["subject"][:35] + ("..." if len(parsed["subject"]) > 35 else "")
                _notify_sync_progress(current_no, total_uids, f"다운로드: {subj_preview}", pct)

            except Exception as item_err:
                log_event("warn", "IMAP", f"UID {uid} 다운로드 실패: {item_err}")
                continue

        # 5. 최종 AI 신경망 벡터 DB(ai_embeddings) 자동 임베딩 연동
        embedded_count = 0
        if auto_embed and downloaded_records:
            _notify_sync_progress(total_uids, total_uids, f"AI 벡터 DB({len(downloaded_records)}건) 임베딩 생성 중...", 92)
            try:
                from services.ai_search_service import embed_new_emails
                embedded_count = embed_new_emails(downloaded_records)
            except Exception as emb_err:
                log_event("warn", "IMAP", f"벡터 임베딩 생성 실패: {emb_err}")

        # 6. 최종 동기화 시각 업데이트
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn = get_db_connection()
        try:
            conn.execute("UPDATE imap_accounts SET last_sync_at = ? WHERE username = ?", (now_str, username))
            conn.commit()
        finally:
            conn.close()

        _notify_sync_complete({
            "status": "success",
            "downloaded": downloaded_count,
            "skipped": skipped_count,
            "embedded": embedded_count,
            "total_processed": total_uids,
            "last_sync_at": now_str
        })

    except Exception as e:
        friendly_msg = _format_imap_error(e, host)
        log_event("error", "IMAP", f"메일 동기화 중 에러: {friendly_msg} (원본: {e})")
        _notify_sync_error(friendly_msg)
    finally:
        _is_sync_running = False
        if client:
            try:
                client.logout()
            except Exception:
                pass


def _notify_sync_progress(current: int, total: int, subject: str, percent: int):
    """Eel IPC를 통한 프론트엔드 진행률 알림"""
    try:
        if hasattr(eel, 'on_imap_sync_progress'):
            eel.on_imap_sync_progress(current, total, subject, percent)()
    except Exception:
        pass


def _notify_sync_complete(result: Dict[str, Any]):
    """Eel IPC를 통한 완료 알림"""
    try:
        if hasattr(eel, 'on_imap_sync_complete'):
            eel.on_imap_sync_complete(result)()
    except Exception:
        pass


def _notify_sync_error(message: str):
    """Eel IPC를 통한 오류 알림"""
    try:
        if hasattr(eel, 'on_imap_sync_error'):
            eel.on_imap_sync_error(message)()
    except Exception:
        pass
