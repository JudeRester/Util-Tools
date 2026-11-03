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
import base64
import hashlib
import secrets
import webbrowser
import http.server
import urllib.request
import urllib.parse
import urllib.error
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


def _format_imap_error(err: Exception, host: str = "", auth_type: str = "password") -> str:
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
            "Google 계정은 일반 비밀번호 대신 16자리 '앱 비밀번호' 또는 'Google OAuth 2.0' 인증이 필요합니다."
        )
    if "AUTHENTICATIONFAILED" in raw_upper or "INVALID CREDENTIALS" in raw_upper:
        if (auth_type or "password") == "oauth2_google":
            return (
                "Google OAuth 2.0 인증 실패(Invalid credentials): 입력된 이메일 계정 주소가 브라우저에서 로그인한 Google 계정 주소와 "
                "정확히 일치하는지 확인해 주세요. (또는 Gmail 설정 → 전달 및 POP/IMAP에서 IMAP이 활성화되어 있어야 합니다.)"
            )
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


def _build_xoauth2_bytes(username: str, access_token: str) -> bytes:
    """Google/표준 IMAP XOAUTH2 SASL 인증 바이트열 생성 (imaplib.authenticate가 base64 인코딩 수행)"""
    user_clean = (username or "").strip()
    token_clean = (access_token or "").strip()
    return f"user={user_clean}\x01auth=Bearer {token_clean}\x01\x01".encode("utf-8")


def _authenticate_imap_client(client, auth_type: str, username: str, password: str = "", access_token: str = ""):
    """인증 방식(password vs oauth2_google)에 따라 IMAP 세션 로그인 수행"""
    if (auth_type or "password") == "oauth2_google":
        if not access_token:
            raise Exception("Google OAuth 2.0 Access Token이 없습니다. 브라우저 로그인을 먼저 진행해 주세요.")
        client.authenticate("XOAUTH2", lambda _: _build_xoauth2_bytes(username, access_token))
    else:
        client.login(username, password)


def _list_imap_folders(client) -> List[Dict[str, str]]:
    """인증된 IMAP 클라이언트로부터 사서함 폴더 목록 조회 및 Modified UTF-7 디코딩"""
    status, folders_raw = client.list()
    folders: List[Dict[str, str]] = []
    has_inbox = False
    if status == "OK" and folders_raw:
        for f in folders_raw:
            if not f:
                continue
            line = f.decode("utf-8", errors="replace")
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
    return folders


def _refresh_google_access_token(client_id: str, client_secret: str, refresh_token: str) -> Dict[str, Any]:
    """Google OAuth 2.0 Refresh Token으로 신규 Access Token 발급"""
    payload = urllib.parse.urlencode({
        "client_id": (client_id or "").strip(),
        "client_secret": (client_secret or "").strip(),
        "refresh_token": (refresh_token or "").strip(),
        "grant_type": "refresh_token",
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if not data.get("access_token"):
                raise Exception(f"토큰 응답에 access_token이 없습니다: {data}")
            return data
    except urllib.error.HTTPError as http_err:
        err_body = http_err.read().decode("utf-8", errors="replace")
        raise Exception(f"Google OAuth 토큰 갱신 실패 ({http_err.code}): {err_body}")


def _get_latest_imap_account_row() -> Optional[Dict[str, Any]]:
    """DB에 저장된 최신 imap_accounts 전체 컬럼 조회"""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM imap_accounts ORDER BY id DESC LIMIT 1").fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def _get_valid_google_access_token(account_cfg: Dict[str, Any]) -> str:
    """유효한 Google Access Token 반환 (만료 60초 전이면 자동 갱신 및 DB 업데이트)"""
    access_token = (account_cfg.get("oauth_access_token") or "").strip()
    expiry = int(account_cfg.get("oauth_token_expiry") or 0)
    now_ts = int(time.time())

    if access_token and expiry > now_ts + 60:
        return access_token

    client_id = (account_cfg.get("oauth_client_id") or "").strip()
    client_secret = (account_cfg.get("oauth_client_secret") or "").strip()
    refresh_token = (account_cfg.get("oauth_refresh_token") or "").strip()

    if not (client_id and client_secret and refresh_token):
        raise Exception(
            "Google OAuth 2.0 인증 토큰이 없거나 만료되었습니다. "
            "[Google 브라우저 로그인 및 권한 승인] 버튼을 눌러 인증을 진행해 주세요."
        )

    refreshed = _refresh_google_access_token(client_id, client_secret, refresh_token)
    new_access_token = refreshed["access_token"]
    expires_in = int(refreshed.get("expires_in") or 3600)
    new_expiry = now_ts + expires_in

    account_cfg["oauth_access_token"] = new_access_token
    account_cfg["oauth_token_expiry"] = new_expiry

    conn = get_db_connection()
    try:
        row = conn.execute("SELECT id FROM imap_accounts ORDER BY id DESC LIMIT 1").fetchone()
        if row:
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            conn.execute("""
                UPDATE imap_accounts
                SET oauth_access_token = ?, oauth_token_expiry = ?, updated_at = ?
                WHERE id = ?
            """, (new_access_token, new_expiry, now_str, row["id"]))
            conn.commit()
    finally:
        conn.close()

    return new_access_token


@eel.expose
def start_google_oauth_flow(client_id: str, client_secret: str, username: str = "") -> Dict[str, Any]:
    """
    Google OAuth 2.0 Desktop Loopback + PKCE 브라우저 인증 수행 후 토큰 저장 및 사서함 폴더 목록 반환
    """
    client_id_clean = (client_id or "").strip()
    client_secret_clean = (client_secret or "").strip()
    user_clean = (username or "").strip()
    if user_clean and "@" not in user_clean:
        user_clean = f"{user_clean}@gmail.com"

    if not client_id_clean or not client_secret_clean:
        return {
            "status": "error",
            "message": "Google Cloud OAuth 2.0 Client ID와 Client Secret을 모두 입력해 주세요."
        }

    code_verifier = secrets.token_urlsafe(48)
    challenge_digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(challenge_digest).rstrip(b"=").decode("ascii")
    state_token = secrets.token_urlsafe(16)

    callback_result: Dict[str, Any] = {"code": None, "error": None, "state": None}
    done_event = threading.Event()

    class _OAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_GET(self):
            parsed_url = urllib.parse.urlparse(self.path)
            if parsed_url.path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return

            qs = urllib.parse.parse_qs(parsed_url.query)
            err = qs.get("error", [None])[0]
            code = qs.get("code", [None])[0]
            st = qs.get("state", [None])[0]

            if not err and not code:
                self.send_response(204)
                self.end_headers()
                return

            callback_result["error"] = err
            callback_result["code"] = code
            callback_result["state"] = st

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            if code and not err:
                body = (
                    "<html><head><meta charset='utf-8'><title>Util-Tools Google OAuth 인증 완료</title></head>"
                    "<body style='font-family:sans-serif;background:#0f172a;color:#f8fafc;text-align:center;padding:60px;'>"
                    "<h2 style='color:#4ade80;'>✅ Google OAuth 2.0 인증이 완료되었습니다!</h2>"
                    "<p style='color:#cbd5e1;'>이 브라우저 탭을 닫고 Util-Tools 앱 화면으로 돌아가 주세요.</p>"
                    "<script>setTimeout(function(){window.close();}, 1500);</script>"
                    "</body></html>"
                )
            else:
                body = (
                    "<html><head><meta charset='utf-8'><title>Util-Tools Google OAuth 인증 실패</title></head>"
                    "<body style='font-family:sans-serif;background:#0f172a;color:#f8fafc;text-align:center;padding:60px;'>"
                    f"<h2 style='color:#f87171;'>❌ 인증 실패: {err or '알 수 없는 오류'}</h2>"
                    "<p style='color:#cbd5e1;'>Util-Tools 앱으로 돌아가 설정을 확인해 주세요.</p>"
                    "</body></html>"
                )
            self.wfile.write(body.encode("utf-8"))
            done_event.set()

    server = http.server.HTTPServer(("127.0.0.1", 0), _OAuthCallbackHandler)
    server.timeout = 1.0
    local_port = server.server_port
    redirect_uri = f"http://localhost:{local_port}/"

    def _serve_until_done():
        deadline = time.time() + 180.0
        while not done_event.is_set() and time.time() < deadline:
            try:
                server.handle_request()
            except Exception:
                break
        try:
            server.server_close()
        except Exception:
            pass

    srv_thread = threading.Thread(target=_serve_until_done, daemon=True)
    srv_thread.start()

    auth_params = {
        "client_id": client_id_clean,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email",
        "access_type": "offline",
        "prompt": "consent",
        "state": state_token,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    if user_clean:
        auth_params["login_hint"] = user_clean

    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(auth_params)
    try:
        webbrowser.open(auth_url)
    except Exception as wb_err:
        done_event.set()
        return {"status": "error", "message": f"브라우저를 열 수 없습니다: {wb_err}"}

    if not done_event.wait(timeout=180.0):
        return {
            "status": "error",
            "message": "브라우저 인증 대기 시간(3분)이 초과되었습니다. 다시 시도해 주세요."
        }

    if callback_result["error"]:
        return {
            "status": "error",
            "message": f"Google OAuth 인증 거부 또는 오류: {callback_result['error']}"
        }

    if callback_result["state"] != state_token or not callback_result["code"]:
        return {
            "status": "error",
            "message": "유효하지 않은 OAuth 콜백 응답입니다 (state 불일치 또는 인가 코드 누락)."
        }

    # 인가 코드(code)를 Access Token / Refresh Token으로 교환
    token_payload = urllib.parse.urlencode({
        "code": callback_result["code"],
        "client_id": client_id_clean,
        "client_secret": client_secret_clean,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": code_verifier,
    }).encode("utf-8")

    token_req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=token_payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(token_req, timeout=15) as resp:
            token_data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as http_err:
        err_body = http_err.read().decode("utf-8", errors="replace")
        return {"status": "error", "message": f"토큰 발급 실패 ({http_err.code}): {err_body}"}
    except Exception as ex:
        return {"status": "error", "message": f"토큰 발급 중 오류: {ex}"}

    access_token = (token_data.get("access_token") or "").strip()
    refresh_token = (token_data.get("refresh_token") or "").strip()
    expires_in = int(token_data.get("expires_in") or 3600)
    token_expiry = int(time.time()) + expires_in

    if not access_token:
        return {"status": "error", "message": "Google OAuth 토큰 응답에 access_token이 없습니다."}

    # 브라우저에서 실제 인증된 Google 계정 이메일 주소를 userinfo API로 조회하여 오타 자동 보정
    try:
        u_req = urllib.request.Request(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            method="GET",
        )
        with urllib.request.urlopen(u_req, timeout=10) as u_resp:
            u_info = json.loads(u_resp.read().decode("utf-8"))
            if u_info.get("email"):
                user_clean = u_info["email"].strip()
    except Exception:
        pass

    if not user_clean:
        return {
            "status": "error",
            "message": "인증된 이메일 계정 주소를 확인할 수 없습니다. 이메일 계정 입력란에 Gmail 주소를 입력한 뒤 다시 시도해 주세요."
        }

    # 기존 refresh_token 보존 (Google이 재로그인 시 refresh_token을 생략한 경우 대비)
    prev_row = _get_latest_imap_account_row()
    if not refresh_token and prev_row and prev_row.get("oauth_refresh_token"):
        refresh_token = prev_row["oauth_refresh_token"]

    save_imap_config({
        "account_name": user_clean,
        "host": "imap.gmail.com",
        "port": 993,
        "use_ssl": True,
        "username": user_clean,
        "password": (prev_row.get("password") if prev_row else "") or "",
        "auth_type": "oauth2_google",
        "oauth_client_id": client_id_clean,
        "oauth_client_secret": client_secret_clean,
        "oauth_refresh_token": refresh_token,
        "oauth_access_token": access_token,
        "oauth_token_expiry": token_expiry,
        "folder": (prev_row.get("folder") if prev_row else "INBOX") or "INBOX",
    })

    # 발급된 토큰으로 즉시 Gmail IMAP 연결 및 폴더 목록 조회
    folders = [{"name": "INBOX", "label": "INBOX (받은편지함)"}]
    try:
        client = _connect_imap("imap.gmail.com", 993, True, timeout=15)
        try:
            _authenticate_imap_client(client, "oauth2_google", user_clean, access_token=access_token)
            folders = _list_imap_folders(client)
            client.logout()
        except Exception as imap_err:
            try:
                client.logout()
            except Exception:
                pass
            return {
                "status": "error",
                "message": f"Google OAuth 토큰은 발급되었으나 Gmail IMAP 접속에 실패했습니다: {_format_imap_error(imap_err, 'imap.gmail.com', 'oauth2_google')}"
            }
    except Exception as conn_err:
        return {
            "status": "error",
            "message": f"Gmail IMAP 서버 연결 실패: {conn_err}"
        }

    log_event("info", "IMAP", f"Google OAuth 2.0 (XOAUTH2) 인증 및 사서함 조회 성공: {user_clean} (폴더 {len(folders)}개)")
    return {
        "status": "success",
        "message": f"Google OAuth 2.0 인증 및 사서함 연결 성공! ({user_clean}, 사서함 {len(folders)}개 조회됨)",
        "username": user_clean,
        "has_token": True,
        "folders": folders,
    }


@eel.expose
def test_imap_connection(
    host: str,
    port: int,
    use_ssl: bool,
    username: str,
    password: str,
    auth_type: str = "password",
    oauth_client_id: str = "",
    oauth_client_secret: str = ""
) -> Dict[str, Any]:
    """IMAP 서버 연결 및 인증 테스트, 사서함 목록 조회 (일반 비밀번호 & Google OAuth 2.0 지원)"""
    try:
        auth_mode = (auth_type or "password").strip()
        host, username, password = _normalize_imap_credentials(host, username, password)
        port = int(port or 993)

        access_token = ""
        if auth_mode == "oauth2_google":
            saved_row = _get_latest_imap_account_row() or {}
            host = host or saved_row.get("host") or "imap.gmail.com"
            username = username or saved_row.get("username") or ""
            if username and "@" not in username and "gmail" in host.lower():
                username = f"{username}@gmail.com"
            if not host or not username:
                return {"status": "error", "message": "이메일 계정 주소(Gmail)를 입력해 주세요."}

            merged_cfg = dict(saved_row)
            if oauth_client_id:
                merged_cfg["oauth_client_id"] = oauth_client_id.strip()
            if oauth_client_secret:
                merged_cfg["oauth_client_secret"] = oauth_client_secret.strip()
            access_token = _get_valid_google_access_token(merged_cfg)
        else:
            if not host or not username or not password:
                return {"status": "error", "message": "호스트 주소, 계정 및 비밀번호를 모두 입력해 주세요."}

        client = _connect_imap(host, port, use_ssl, timeout=12)
        try:
            _authenticate_imap_client(client, auth_mode, username, password=password, access_token=access_token)
            folders = _list_imap_folders(client)
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
            friendly_msg = _format_imap_error(auth_err, host, auth_mode)
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
                SELECT id, account_name, host, port, use_ssl, username, password,
                       auth_type, oauth_client_id, oauth_client_secret,
                       oauth_refresh_token, oauth_access_token, oauth_token_expiry,
                       folder, last_sync_at
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
                        "password": row["password"] or "",
                        "auth_type": row["auth_type"] or "password",
                        "oauth_client_id": row["oauth_client_id"] or "",
                        "oauth_client_secret": row["oauth_client_secret"] or "",
                        "has_oauth_token": bool(row["oauth_refresh_token"] or row["oauth_access_token"]),
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
                    "auth_type": "password",
                    "oauth_client_id": "",
                    "oauth_client_secret": "",
                    "has_oauth_token": False,
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
        auth_type = (config.get("auth_type") or "password").strip()
        oauth_client_id = (config.get("oauth_client_id") or "").strip()
        oauth_client_secret = (config.get("oauth_client_secret") or "").strip()

        if not host or not username:
            return {"status": "error", "message": "호스트 주소와 계정 아이디는 필수입니다."}

        conn = get_db_connection()
        try:
            row = conn.execute("SELECT * FROM imap_accounts ORDER BY id DESC LIMIT 1").fetchone()
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            prev_dict = dict(row) if row else {}
            oauth_refresh_token = config.get("oauth_refresh_token")
            if oauth_refresh_token is None:
                oauth_refresh_token = prev_dict.get("oauth_refresh_token") or ""

            oauth_access_token = config.get("oauth_access_token")
            if oauth_access_token is None:
                oauth_access_token = prev_dict.get("oauth_access_token") or ""

            oauth_token_expiry = config.get("oauth_token_expiry")
            if oauth_token_expiry is None:
                oauth_token_expiry = int(prev_dict.get("oauth_token_expiry") or 0)
            else:
                oauth_token_expiry = int(oauth_token_expiry or 0)

            if not oauth_client_id and prev_dict.get("oauth_client_id"):
                oauth_client_id = prev_dict["oauth_client_id"]
            if not oauth_client_secret and prev_dict.get("oauth_client_secret"):
                oauth_client_secret = prev_dict["oauth_client_secret"]

            if row:
                conn.execute("""
                    UPDATE imap_accounts
                    SET account_name = ?, host = ?, port = ?, use_ssl = ?, username = ?, password = ?,
                        auth_type = ?, oauth_client_id = ?, oauth_client_secret = ?,
                        oauth_refresh_token = ?, oauth_access_token = ?, oauth_token_expiry = ?,
                        folder = ?, updated_at = ?
                    WHERE id = ?
                """, (
                    account_name, host, port, use_ssl, username, password,
                    auth_type, oauth_client_id, oauth_client_secret,
                    oauth_refresh_token, oauth_access_token, oauth_token_expiry,
                    folder, now_str, row["id"]
                ))
            else:
                conn.execute("""
                    INSERT INTO imap_accounts (
                        account_name, host, port, use_ssl, username, password,
                        auth_type, oauth_client_id, oauth_client_secret,
                        oauth_refresh_token, oauth_access_token, oauth_token_expiry,
                        folder, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    account_name, host, port, use_ssl, username, password,
                    auth_type, oauth_client_id, oauth_client_secret,
                    oauth_refresh_token, oauth_access_token, oauth_token_expiry,
                    folder, now_str, now_str
                ))

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
        - host, port, use_ssl, username, password, auth_type, oauth_client_id, oauth_client_secret, folder
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

    saved_row = _get_latest_imap_account_row() or {}

    host = options.get("host") or saved_row.get("host") or ""
    username = options.get("username") or saved_row.get("username") or ""
    password = options.get("password") if options.get("password") is not None else (saved_row.get("password") or "")
    auth_type = (options.get("auth_type") or saved_row.get("auth_type") or "password").strip()
    port = int(options.get("port") or saved_row.get("port") or 993)
    use_ssl = bool(options.get("use_ssl", saved_row.get("use_ssl", True)))
    folder = options.get("folder") or saved_row.get("folder") or "INBOX"
    since_days = options.get("since_days")  # None 또는 int
    limit = options.get("limit")  # None 또는 int
    auto_embed = options.get("auto_embed", True)

    host, username, password = _normalize_imap_credentials(host, username, password)

    if auth_type == "oauth2_google":
        if not (host and username):
            _is_sync_running = False
            _notify_sync_error("IMAP 호스트와 이메일 계정 주소를 확인해 주세요.")
            return
    else:
        if not (host and username and password):
            _is_sync_running = False
            _notify_sync_error("IMAP 계정 설정 정보가 올바르지 않습니다.")
            return

    client = None
    try:
        _notify_sync_progress(0, 1, "IMAP 서버에 연결 중...", 0)
        access_token = ""
        if auth_type == "oauth2_google":
            merged_cfg = dict(saved_row)
            if options.get("oauth_client_id"):
                merged_cfg["oauth_client_id"] = options["oauth_client_id"].strip()
            if options.get("oauth_client_secret"):
                merged_cfg["oauth_client_secret"] = options["oauth_client_secret"].strip()
            access_token = _get_valid_google_access_token(merged_cfg)

        client = _connect_imap(host, port, use_ssl, timeout=20)
        _authenticate_imap_client(client, auth_type, username, password=password, access_token=access_token)

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
        friendly_msg = _format_imap_error(e, host, auth_type)
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
