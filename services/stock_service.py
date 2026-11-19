"""
services/stock_service.py
Toss Open API & Real-time Stock / FX Streaming Service Module
- Manages data/stock_config.json (client_id, client_secret, watchlist, fx_cache)
- Toss Open API OAuth2 authentication (POST https://openapi.tossinvest.com/oauth2/token)
- REST: USD/KRW & JPY/KRW FX exchange rate caching (60s TTL), stock master list, initial quotes
- WebSocket streaming (wss://openapi-ws.tossinvest.com/ws/v1) with exponential backoff & pause/resume
- Eel exposed RPC endpoints for Quick Widget frontend integration
"""
import os
import sys
import json
import time
import ssl
import random
import threading
import urllib.request
import urllib.parse
import urllib.error
from typing import Any, Dict, List, Optional
import concurrent.futures
import eel

from core.paths import DATA_DIR, STOCK_CONFIG_PATH, STOCK_MASTER_PATH
import core.logger

logger = core.logger

# Global In-Memory State
_widget_window = None
_config_lock = threading.Lock()
_cache_lock = threading.Lock()
_token_lock = threading.Lock()
_stream_lock = threading.Lock()
_market_calendar_lock = threading.Lock()
_toss_rate_lock = threading.Lock()
_prev_close_backfill_lock = threading.Lock()

_access_token: Optional[str] = None
_token_expires_at: float = 0.0
_last_token_fail_time: float = 0.0

_toss_min_req_interval: float = 1.1
_last_toss_req_time: float = 0.0
_toss_next_allowed_time: float = 0.0
_toss_rate_limited_until: float = 0.0
_toss_forbidden_until: float = 0.0
_last_429_log_time: float = 0.0
_last_403_log_time: float = 0.0
_last_batch_price_time: float = 0.0
_prev_close_inflight: set = set()

_fx_cache: Dict[str, Any] = {"data": None, "expires_at": 0.0}
_quote_cache: Dict[str, Dict[str, Any]] = {}
_master_cache: List[Dict[str, Any]] = []
_prev_close_cache: Dict[str, Dict[str, Any]] = {}
_market_calendar_cache: Dict[str, Dict[str, Any]] = {}


class _TossRateLimitError(Exception):
    """Raised when Toss Open API returns HTTP 429 or cooldown is active."""
    pass


class _TossForbiddenError(Exception):
    """Raised when Toss Open API returns HTTP 403 Forbidden or forbidden cooldown is active."""
    pass


# Streaming State
_is_streaming_active: bool = False
_is_paused: bool = False
_ws_thread: Optional[threading.Thread] = None
_stop_streaming_event = threading.Event()
_wake_event = threading.Event()
_backoff_delay: float = 1.0
_active_ws: Any = None
_last_broadcast_time: Dict[str, float] = {}
_last_rest_quote_sync: float = 0.0
_consecutive_ws_failures: int = 0

# SSL context for outbound HTTPS API calls
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

DEFAULT_WATCHLIST = [
    {"code": "005930", "name": "삼성전자", "market": "KR"},
    {"code": "AAPL", "name": "Apple", "market": "US"},
    {"code": "NVDA", "name": "NVIDIA", "market": "US"},
    {"code": "TSLA", "name": "Tesla", "market": "US"}
]

DEFAULT_MASTER_STOCKS = [
    {"code": "005930", "name": "삼성전자", "market": "KR"},
    {"code": "000660", "name": "SK하이닉스", "market": "KR"},
    {"code": "373220", "name": "LG에너지솔루션", "market": "KR"},
    {"code": "005380", "name": "현대차", "market": "KR"},
    {"code": "035420", "name": "NAVER", "market": "KR"},
    {"code": "035720", "name": "카카오", "market": "KR"},
    {"code": "AAPL", "name": "Apple", "market": "US"},
    {"code": "MSFT", "name": "Microsoft", "market": "US"},
    {"code": "NVDA", "name": "NVIDIA", "market": "US"},
    {"code": "TSLA", "name": "Tesla", "market": "US"},
    {"code": "AMZN", "name": "Amazon", "market": "US"},
    {"code": "GOOGL", "name": "Alphabet (Google)", "market": "US"},
    {"code": "META", "name": "Meta Platforms", "market": "US"}
]


def set_widget_window(window: Any) -> None:
    """Store pywebview window reference for native evaluate_js broadcast."""
    global _widget_window
    _widget_window = window


# -----------------------------------------------------------------------------
# Configuration Persistence
# -----------------------------------------------------------------------------

def load_stock_config() -> Dict[str, Any]:
    with _config_lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        if not os.path.exists(STOCK_CONFIG_PATH):
            default_conf = {
                "client_id": "",
                "client_secret": "",
                "active_group_id": "g_default",
                "groups": [
                    {"id": "g_default", "name": "기본", "codes": [s.get("code") for s in DEFAULT_WATCHLIST if s.get("code")]}
                ],
                "watchlist": DEFAULT_WATCHLIST,
                "fx_cache": {}
            }
            try:
                with open(STOCK_CONFIG_PATH, "w", encoding="utf-8") as f:
                    json.dump(default_conf, f, indent=2, ensure_ascii=False)
            except Exception as e:
                logger.log_error("StockService", f"Failed to create stock config: {e}")
            return default_conf

        try:
            with open(STOCK_CONFIG_PATH, "r", encoding="utf-8") as f:
                conf = json.load(f)
        except Exception as e:
            logger.log_warn("StockService", f"Failed to read stock config: {e}")
            return {
                "client_id": "",
                "client_secret": "",
                "active_group_id": "g_default",
                "groups": [
                    {"id": "g_default", "name": "기본", "codes": [s.get("code") for s in DEFAULT_WATCHLIST if s.get("code")]}
                ],
                "watchlist": DEFAULT_WATCHLIST,
                "fx_cache": {}
            }

        migrated = False
        if "groups" not in conf or not isinstance(conf.get("groups"), list) or len(conf["groups"]) == 0:
            existing_codes = [s.get("code") for s in conf.get("watchlist", []) if s.get("code")]
            conf["groups"] = [
                {"id": "g_default", "name": "기본", "codes": existing_codes}
            ]
            migrated = True

        if "active_group_id" not in conf or not any(g.get("id") == conf.get("active_group_id") for g in conf["groups"]):
            conf["active_group_id"] = conf["groups"][0]["id"]
            migrated = True

        if migrated:
            try:
                with open(STOCK_CONFIG_PATH, "w", encoding="utf-8") as f:
                    json.dump(conf, f, indent=2, ensure_ascii=False)
            except Exception as e:
                logger.log_warn("StockService", f"Failed to persist migrated stock config: {e}")

        return conf


def save_stock_config(data: Dict[str, Any]) -> bool:
    with _config_lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp_path = f"{STOCK_CONFIG_PATH}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            if os.path.exists(STOCK_CONFIG_PATH):
                os.replace(tmp_path, STOCK_CONFIG_PATH)
            else:
                os.rename(tmp_path, STOCK_CONFIG_PATH)
            return True
        except Exception as e:
            logger.log_error("StockService", f"Failed to save stock config: {e}")
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
            return False


# -----------------------------------------------------------------------------
# Toss Open API OAuth2 Authentication & Rate-Limited REST Client
# -----------------------------------------------------------------------------

def invalidate_access_token(failed_token: Optional[str] = None, reason: str = "") -> None:
    """Clear cached OAuth2 token so the next request/socket reconnect issues a fresh one."""
    global _access_token, _token_expires_at
    with _token_lock:
        if failed_token is None or _access_token == failed_token:
            if _access_token is not None:
                suffix = f" ({reason})" if reason else ""
                logger.log_info("StockService", f"Invalidating stale Toss OAuth2 access token for refresh{suffix}")
            _access_token = None
            _token_expires_at = 0.0


def _update_toss_rate_from_headers(headers: Any) -> None:
    """Adapt request spacing dynamically using Toss X-RateLimit-* response headers."""
    global _toss_min_req_interval, _toss_next_allowed_time
    if not headers:
        return
    try:
        limit_raw = headers.get("X-RateLimit-Limit")
        rem_raw = headers.get("X-RateLimit-Remaining")
        reset_raw = headers.get("X-RateLimit-Reset")
        with _toss_rate_lock:
            if limit_raw is not None:
                limit_val = float(limit_raw)
                if limit_val <= 1.0:
                    _toss_min_req_interval = max(_toss_min_req_interval, 1.15)
                elif limit_val <= 2.0:
                    _toss_min_req_interval = max(_toss_min_req_interval, 0.7)
            if rem_raw is not None and float(rem_raw) <= 0.0:
                reset_sec = float(reset_raw) if reset_raw is not None else _toss_min_req_interval
                wait_s = max(1.05, min(30.0, reset_sec + 0.15))
                _toss_next_allowed_time = max(_toss_next_allowed_time, time.time() + wait_s)
    except Exception:
        pass


def _extract_toss_error_code(err: urllib.error.HTTPError) -> str:
    """Safely extract Toss API error.code or message from an HTTPError body."""
    try:
        raw = err.read().decode("utf-8", errors="ignore").strip()
        if raw:
            try:
                body = json.loads(raw)
                err_obj = body.get("error") if isinstance(body, dict) else None
                if isinstance(err_obj, dict) and err_obj.get("code"):
                    return str(err_obj.get("code"))
                if isinstance(body, dict) and body.get("error"):
                    return str(body.get("error"))
                if isinstance(body, dict) and body.get("message"):
                    return str(body.get("message"))
            except Exception:
                return raw[:120]
    except Exception:
        pass
    return ""


def _wait_toss_rate_slot() -> None:
    """Block until the next safe Toss REST API request slot is available."""
    global _last_toss_req_time
    with _toss_rate_lock:
        now = time.time()
        if now < _toss_rate_limited_until:
            raise _TossRateLimitError("Toss REST API cooldown active")
        if now < _toss_forbidden_until:
            raise _TossForbiddenError("Toss REST API HTTP 403 cooldown active")
        target_time = max(_last_toss_req_time + _toss_min_req_interval, _toss_next_allowed_time)
        if target_time > now:
            time.sleep(target_time - now)
        _last_toss_req_time = time.time()


def _fetch_access_token(client_id: str, client_secret: str) -> Optional[str]:
    global _access_token, _token_expires_at, _last_token_fail_time, _last_toss_req_time
    if not client_id or not client_secret:
        return None

    with _token_lock:
        url = "https://openapi.tossinvest.com/oauth2/token"
        payload = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": client_id.strip(),
            "client_secret": client_secret.strip()
        }).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "UtilTools-EdgeWidget/1.0"
            },
            method="POST"
        )

        # Space out token request so edge rate limiter does not see burst with adjacent REST call
        with _toss_rate_lock:
            now = time.time()
            elapsed = now - _last_toss_req_time
            if elapsed < _toss_min_req_interval:
                time.sleep(_toss_min_req_interval - elapsed)
            _last_toss_req_time = time.time()

        try:
            with urllib.request.urlopen(req, timeout=5.0, context=_SSL_CTX) as resp:
                _update_toss_rate_from_headers(resp.headers)
                data = json.loads(resp.read().decode("utf-8"))
                token = data.get("access_token")
                expires_in = int(data.get("expires_in", 3600))
                if token:
                    _access_token = token
                    _token_expires_at = time.time() + max(60, expires_in - 60)
                    _last_token_fail_time = 0.0
                    logger.log_info("StockService", "Toss Open API OAuth2 access token issued successfully")
                    return token
        except Exception as e:
            _last_token_fail_time = time.time()
            logger.log_warn("StockService", f"Failed to obtain Toss OAuth token: {e}")
        return None


def get_valid_token(min_ttl: float = 0.0, force_refresh: bool = False) -> Optional[str]:
    global _access_token, _token_expires_at, _last_token_fail_time
    with _token_lock:
        now = time.time()
        if not force_refresh and _access_token and (now + max(0.0, min_ttl)) < _token_expires_at:
            return _access_token
        if not force_refresh and _last_token_fail_time and (now - _last_token_fail_time) < 10.0:
            return None

    conf = load_stock_config()
    cid = conf.get("client_id", "")
    csec = conf.get("client_secret", "")
    if cid and csec:
        with _token_lock:
            if not force_refresh and _access_token and (time.time() + max(0.0, min_ttl)) < _token_expires_at:
                return _access_token
        return _fetch_access_token(cid, csec)
    return None


def _toss_api_get_json(url: str, timeout: float = 3.0, retry_on_401: bool = True) -> Optional[Dict[str, Any]]:
    """
    Adaptive rate-limited GET helper for Toss Open API REST endpoints.
    - Respects X-RateLimit-Limit / Remaining / Reset headers (including 1-TPS restricted IP ranges).
    - Enforces 429 and 403 cooldown windows so cascading calls stop immediately.
    - Automatically invalidates and refreshes OAuth2 token once on HTTP 401.
    """
    global _toss_min_req_interval, _toss_rate_limited_until, _toss_forbidden_until
    global _last_429_log_time, _last_403_log_time

    token = get_valid_token()
    if not token:
        return None

    _wait_toss_rate_slot()

    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "UtilTools-EdgeWidget/1.0"
        }
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
            _update_toss_rate_from_headers(resp.headers)
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_code = _extract_toss_error_code(e)
        if e.code == 401 and retry_on_401:
            invalidate_access_token(token, reason=err_code or "HTTP 401")
            new_token = get_valid_token(force_refresh=True)
            if new_token:
                return _toss_api_get_json(url, timeout=timeout, retry_on_401=False)
            raise
        if e.code == 403:
            now = time.time()
            with _toss_rate_lock:
                _toss_forbidden_until = max(_toss_forbidden_until, now + 15.0)
                should_log = (now - _last_403_log_time) >= 30.0
                if should_log:
                    _last_403_log_time = now
            if should_log:
                endpoint = urllib.parse.urlparse(url).path
                detail = f", code={err_code}" if err_code else ""
                logger.log_warn(
                    "StockService",
                    f"Toss API HTTP 403 Forbidden (endpoint={endpoint}{detail}); 허용 공인 IP(VPN/네트워크 변경) 또는 API 키 권한을 확인하세요."
                )
            raise _TossForbiddenError(err_code or str(e))
        if e.code == 429:
            retry_after = 5.0
            limit_hdr = ""
            try:
                if e.headers:
                    limit_hdr = str(e.headers.get("X-RateLimit-Limit") or "")
                    hdr_val = e.headers.get("Retry-After")
                    if hdr_val:
                        retry_after = max(2.0, min(60.0, float(hdr_val) + 1.0))
            except Exception:
                pass
            now = time.time()
            with _toss_rate_lock:
                _toss_min_req_interval = max(_toss_min_req_interval, 1.2)
                _toss_rate_limited_until = max(_toss_rate_limited_until, now + retry_after)
                should_log = (now - _last_429_log_time) >= 10.0
                if should_log:
                    _last_429_log_time = now
            if should_log:
                endpoint = urllib.parse.urlparse(url).path
                detail_parts = [f"endpoint={endpoint}"]
                if err_code:
                    detail_parts.append(f"code={err_code}")
                if limit_hdr:
                    detail_parts.append(f"limit={limit_hdr}/s")
                logger.log_warn(
                    "StockService",
                    f"Toss API rate limit (HTTP 429, {', '.join(detail_parts)}); pausing REST for {retry_after:.0f}s"
                )
            raise _TossRateLimitError(str(e))
        raise


# -----------------------------------------------------------------------------
# REST: Exchange Rates (USD/KRW & JPY/KRW)
# -----------------------------------------------------------------------------

def fetch_exchange_rates(force_refresh: bool = False) -> Dict[str, Any]:
    global _fx_cache
    now = time.time()
    with _cache_lock:
        if not force_refresh and _fx_cache["data"] and now < _fx_cache["expires_at"]:
            return _fx_cache["data"]

    usd_krw = 1380.0
    jpy_krw = 915.0
    usd_change = 0.0
    jpy_change = 0.0

    # 1. Try Toss Open API for USD/KRW (requires baseCurrency=USD&quoteCurrency=KRW)
    toss_success = False
    try:
        tdata = _toss_api_get_json(
            "https://openapi.tossinvest.com/api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW",
            timeout=3.0
        )
        if tdata:
            item = tdata.get("result", {})
            if item and "rate" in item:
                rate_val = float(item.get("rate", 0))
                mid_val = float(item.get("midRate", rate_val))
                chg_type = item.get("rateChangeType", "FLAT")
                chg_val = round(rate_val - mid_val, 2)
                if chg_type == "DOWN" and chg_val > 0:
                    chg_val = -chg_val
                usd_krw = rate_val
                usd_change = chg_val
                toss_success = True
    except (_TossRateLimitError, _TossForbiddenError):
        pass
    except Exception as e:
        logger.log_warn("StockService", f"Toss FX fetch bypass: {e}")

    # 2. Fetch JPY (and USD fallback) from Public Currency API
    try:
        req = urllib.request.Request("https://open.er-api.com/v6/latest/USD", headers={"User-Agent": "curl/7.68.0"})
        with urllib.request.urlopen(req, timeout=2.5, context=_SSL_CTX) as resp:
            pdata = json.loads(resp.read().decode("utf-8"))
            rates_map = pdata.get("rates", {})
            krw_rate = float(rates_map.get("KRW", 0))
            jpy_rate = float(rates_map.get("JPY", 0))
            if not toss_success and krw_rate > 0:
                usd_krw = round(krw_rate, 2)
            if krw_rate > 0 and jpy_rate > 0:
                jpy_krw = round((krw_rate / jpy_rate) * 100, 2)
    except Exception as e:
        logger.log_warn("StockService", f"Public FX fetch bypass: {e}")

    result = {
        "USD": {
            "code": "USD",
            "rate": usd_krw,
            "change": usd_change,
            "change_rate": round((usd_change / (usd_krw - usd_change) * 100) if (usd_krw - usd_change) else 0.0, 2),
            "formatted": f"{usd_krw:,.2f}"
        },
        "JPY": {
            "code": "JPY",
            "rate": jpy_krw,
            "change": jpy_change,
            "change_rate": round((jpy_change / (jpy_krw - jpy_change) * 100) if (jpy_krw - jpy_change) else 0.0, 2),
            "formatted": f"{jpy_krw:,.2f}"
        }
    }

    with _cache_lock:
        _fx_cache = {"data": result, "expires_at": now + 120.0}

    return result


# -----------------------------------------------------------------------------
# REST: Stock Master List & Initial Price Quotes
# -----------------------------------------------------------------------------


def sync_master_stocks_background() -> None:
    """Background task to fetch and cache all listed stocks from Toss Open API."""
    def _run():
        token = get_valid_token()
        if not token:
            return
        logger.log_info("StockService", "Starting stock universe sync from Toss Open API...")
        all_stocks = []
        for m in ['KOSPI', 'KOSDAQ', 'NASDAQ', 'NYSE']:
            time.sleep(1.2)
            url = f"https://openapi.tossinvest.com/api/v1/stocks/all?market={m}"
            try:
                d = _toss_api_get_json(url, timeout=5.0)
                if not d:
                    continue
                items = d.get('result', [])
                for it in items:
                    sym = it.get('symbol')
                    nm = it.get('name')
                    if sym and nm:
                        all_stocks.append({
                            'code': sym,
                            'name': nm,
                            'market': 'KR' if m in ('KOSPI', 'KOSDAQ') else 'US'
                        })
                logger.log_debug("StockService", f"Synced {m}: {len(items)} items")
            except (_TossRateLimitError, _TossForbiddenError):
                logger.log_warn("StockService", f"Skipped remaining master sync due to API restriction at {m}")
                break
            except Exception as e:
                logger.log_warn("StockService", f"Failed to sync {m} stocks: {e}")

        if all_stocks:
            try:
                os.makedirs(DATA_DIR, exist_ok=True)
                with open(STOCK_MASTER_PATH, "w", encoding="utf-8") as f:
                    json.dump(all_stocks, f, ensure_ascii=False, indent=2)
                global _master_cache
                with _cache_lock:
                    _master_cache = all_stocks
                logger.log_info("StockService", f"Stock master universe sync complete: {len(all_stocks)} stocks cached")
            except Exception as e:
                logger.log_error("StockService", f"Failed to save stock master: {e}")

    threading.Thread(target=_run, name="StockMasterSyncThread", daemon=True).start()


def load_master_stocks() -> List[Dict[str, Any]]:
    global _master_cache
    with _cache_lock:
        if _master_cache:
            return _master_cache

    if os.path.exists(STOCK_MASTER_PATH):
        try:
            with open(STOCK_MASTER_PATH, "r", encoding="utf-8") as f:
                _master_cache = json.load(f)
                if _master_cache:
                    return _master_cache
        except Exception as e:
            logger.log_warn("StockService", f"Failed to load stock master cache: {e}")

    _master_cache = list(DEFAULT_MASTER_STOCKS)
    return _master_cache


def fetch_regular_market_close_cut(market: str, token: Optional[str] = None) -> Optional[str]:
    """Fetch previous business day regular market end time cut with lock to prevent cache stampede."""
    now = time.time()
    with _cache_lock:
        cached = _market_calendar_cache.get(market)
        if cached and now < cached.get("expires_at", 0.0):
            return cached.get("cut_time")

    with _market_calendar_lock:
        now = time.time()
        with _cache_lock:
            cached = _market_calendar_cache.get(market)
            if cached and now < cached.get("expires_at", 0.0):
                return cached.get("cut_time")

        try:
            url = f"https://openapi.tossinvest.com/api/v1/market-calendar/{market}"
            data = _toss_api_get_json(url, timeout=3.0)
            if data:
                prev_biz = data.get("result", {}).get("previousBusinessDay", {})
                cut_time = None
                if market == "KR":
                    end_t = prev_biz.get("integrated", {}).get("regularMarket", {}).get("endTime")
                    if end_t:
                        if "15:30:00" in end_t:
                            cut_time = end_t.replace("15:30:00", "15:31:00")
                        else:
                            cut_time = end_t
                else:
                    cut_time = prev_biz.get("regularMarket", {}).get("endTime")

                if cut_time:
                    with _cache_lock:
                        _market_calendar_cache[market] = {
                            "cut_time": cut_time,
                            "expires_at": time.time() + 1800.0
                        }
                    return cut_time
        except (_TossRateLimitError, _TossForbiddenError):
            with _cache_lock:
                _market_calendar_cache[market] = {
                    "cut_time": None,
                    "expires_at": time.time() + 60.0
                }
            return None
        except Exception as e:
            logger.log_debug("StockService", f"Market calendar fetch notice for {market}: {e}")
            with _cache_lock:
                _market_calendar_cache[market] = {
                    "cut_time": None,
                    "expires_at": time.time() + 30.0
                }

    return None


def _fetch_kr_prev_close_naver(symbol: str) -> Optional[float]:
    """Fetch KR stock previous close via Naver Finance mobile basic API (uses no Toss quota)."""
    try:
        clean_sym = symbol.replace(".KS", "").replace(".KQ", "")
        url = f"https://m.stock.naver.com/api/stock/{clean_sym}/basic"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            ndata = json.loads(resp.read().decode("utf-8"))
            cur_str = str(ndata.get("closePrice", "0")).replace(",", "")
            diff_str = str(ndata.get("compareToPreviousClosePrice", "0")).replace(",", "")
            cur_p = float(cur_str)
            diff_p = float(diff_str)
            if cur_p > 0:
                return cur_p - diff_p
    except Exception as e:
        logger.log_debug("StockService", f"Naver prev close fallback failed for {symbol}: {e}")
    return None


def _fetch_us_prev_close_yahoo(symbol: str) -> Optional[float]:
    """Fetch US stock previous regular close via Yahoo Finance chart API (uses no Toss quota)."""
    try:
        yahoo_sym = symbol.strip().upper().replace(".", "-")
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_sym)}?range=1d&interval=1d"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=2.5, context=_SSL_CTX) as resp:
            ydata = json.loads(resp.read().decode("utf-8"))
            res_list = ydata.get("chart", {}).get("result") or []
            if res_list:
                meta = res_list[0].get("meta", {})
                prev_c = meta.get("previousClose")
                if prev_c is None:
                    prev_c = meta.get("chartPreviousClose")
                if prev_c is not None and float(prev_c) > 0:
                    return round(float(prev_c), 4)
    except Exception as e:
        logger.log_debug("StockService", f"Yahoo prev close fetch notice for {symbol}: {e}")
    return None


def fetch_prev_close(symbol: str, token: Optional[str] = None) -> Optional[float]:
    """
    Fetch previous regular session close price (전일 정규장 종가 기준).
    - Uses Naver Finance (KR) and Yahoo Finance (US) first to consume zero Toss Open API quota.
    - Falls back to Toss Open API candles (rate-limited) only if external lookup fails.
    """
    if not symbol:
        return None

    now = time.time()
    with _cache_lock:
        cached = _prev_close_cache.get(symbol)
        if cached and now < cached.get("expires_at", 0.0):
            return cached.get("price")

    is_kr = symbol.isdigit() or symbol.endswith(".KS") or symbol.endswith(".KQ")
    market = "KR" if is_kr else "US"
    prev_close = None
    blocked_or_limited = False

    # Primary: Zero-Toss-quota lookups (Naver Finance for KR, Yahoo Finance for US)
    if is_kr:
        prev_close = _fetch_kr_prev_close_naver(symbol)
    else:
        prev_close = _fetch_us_prev_close_yahoo(symbol)

    # Fallback 1: Query Toss 1m candle before regular session close cut
    if prev_close is None:
        cut_time = fetch_regular_market_close_cut(market)
        if cut_time:
            try:
                url = (
                    f"https://openapi.tossinvest.com/api/v1/candles"
                    f"?symbol={urllib.parse.quote(symbol)}&interval=1m&before={urllib.parse.quote(cut_time)}&count=1"
                )
                data = _toss_api_get_json(url, timeout=3.0)
                if data:
                    candles = data.get("result", {}).get("candles", [])
                    if candles and candles[0].get("closePrice") is not None:
                        prev_close = float(candles[0].get("closePrice"))
            except (_TossRateLimitError, _TossForbiddenError):
                blocked_or_limited = True
            except Exception as e:
                logger.log_debug("StockService", f"1m regular close candle fetch failed for {symbol}: {e}")

    # Fallback 2: Toss 1d daily candles (skip if already rate-limited or forbidden)
    if prev_close is None and not blocked_or_limited:
        try:
            url = f"https://openapi.tossinvest.com/api/v1/candles?symbol={urllib.parse.quote(symbol)}&interval=1d"
            data = _toss_api_get_json(url, timeout=3.0)
            if data:
                candles = data.get("result", {}).get("candles", [])
                if len(candles) >= 2:
                    c_val = candles[1].get("closePrice")
                    if c_val is not None:
                        prev_close = float(c_val)
                elif len(candles) == 1:
                    o_val = candles[0].get("openPrice")
                    if o_val is not None:
                        prev_close = float(o_val)
        except (_TossRateLimitError, _TossForbiddenError):
            blocked_or_limited = True
        except Exception as e:
            logger.log_warn("StockService", f"Failed to fetch prev close for {symbol}: {e}")

    if prev_close is not None:
        with _cache_lock:
            _prev_close_cache[symbol] = {
                "price": prev_close,
                "expires_at": time.time() + 3600.0
            }
        return prev_close

    return None


def _schedule_prev_close_backfill(codes: List[str]) -> None:
    """Sequentially backfill uncached prev_close values in the background without consuming Toss quota."""
    to_fetch = []
    with _prev_close_backfill_lock:
        for c in codes:
            if c and c not in _prev_close_inflight:
                _prev_close_inflight.add(c)
                to_fetch.append(c)

    if not to_fetch:
        return

    def _worker():
        try:
            for c in to_fetch:
                if _stop_streaming_event.is_set():
                    break
                try:
                    prev_close = fetch_prev_close(c)
                    if prev_close is None:
                        continue
                    with _cache_lock:
                        q = _quote_cache.get(c)
                        if not q:
                            continue
                        p_val = float(q.get("price", 0.0))
                        curr = q.get("currency", "KRW" if c.isdigit() else "USD")
                        is_us = curr == "USD" or not c.isdigit()
                        c_val = round(p_val - prev_close, 2 if is_us else 0)
                        cr_val = round((c_val / prev_close * 100), 2) if prev_close else 0.0
                        q["base_price"] = prev_close
                        q["change"] = c_val
                        q["change_rate"] = cr_val
                        update_payload = {
                            "code": c,
                            "price": p_val,
                            "prev_price": p_val,
                            "tick_diff": 0.0,
                            "base_price": prev_close,
                            "change": c_val,
                            "change_rate": cr_val,
                            "session": q.get("session", "REG"),
                            "currency": curr,
                            "formatted_price": q.get("formatted_price"),
                            "silent": True
                        }
                    broadcast_tick_update(update_payload)
                except Exception as ex:
                    logger.log_debug("StockService", f"Background prev_close backfill notice for {c}: {ex}")
                time.sleep(0.05)
        finally:
            with _prev_close_backfill_lock:
                for c in to_fetch:
                    _prev_close_inflight.discard(c)

    threading.Thread(target=_worker, name="StockPrevCloseBackfillThread", daemon=True).start()


def fetch_initial_prices(symbols: List[Dict[str, Any]], force_refresh: bool = False) -> Dict[str, Dict[str, Any]]:
    """Fetch initial quotes using batch GET /api/v1/prices?symbols=... with rate-limit protection."""
    global _last_batch_price_time, _last_rest_quote_sync
    results = {}
    code_list = [s.get("code") for s in symbols if s.get("code")]

    # 1. Base skeleton from cache or defaults
    with _cache_lock:
        for sym in symbols:
            code = sym.get("code", "")
            name = sym.get("name", code)
            market = sym.get("market", "KR" if code.isdigit() else "US")
            base_p = 72000.0 if market == "KR" else 210.0
            quote = {
                "code": code,
                "name": name,
                "market": market,
                "price": base_p,
                "base_price": base_p,
                "change": 0.0,
                "change_rate": 0.0,
                "session": "REG",
                "currency": "KRW" if market == "KR" else "USD",
                "formatted_price": f"{int(base_p):,}원" if market == "KR" else f"${base_p:,.2f}"
            }
            if code in _quote_cache:
                quote.update(_quote_cache[code])
            results[code] = quote

    # 2. Batch fetch live prices from Toss (skip if recently fetched within 5s unless forced or uncached)
    now = time.time()
    has_uncached_quote = any(c not in _quote_cache for c in code_list)
    should_fetch_batch = bool(code_list) and (force_refresh or has_uncached_quote or (now - _last_batch_price_time) >= 5.0)
    if should_fetch_batch:
        try:
            for i in range(0, len(code_list), 50):
                chunk = code_list[i:i + 50]
                symbols_param = urllib.parse.quote(",".join(chunk))
                url = f"https://openapi.tossinvest.com/api/v1/prices?symbols={symbols_param}"
                pdata = _toss_api_get_json(url, timeout=3.0)
                if not pdata:
                    continue
                items = pdata.get("result", [])
                for it in items:
                    c = it.get("symbol")
                    if c in results:
                        p_val = float(it.get("lastPrice", results[c]["price"]))
                        curr = it.get("currency", results[c]["currency"])
                        results[c]["price"] = p_val
                        results[c]["currency"] = curr
                        results[c]["formatted_price"] = f"{int(p_val):,}원" if curr == "KRW" else f"${p_val:,.2f}"
            _last_batch_price_time = time.time()
        except (_TossRateLimitError, _TossForbiddenError):
            pass
        except Exception as e:
            logger.log_warn("StockService", f"Batch prices fetch notice: {e}")

    # 3. Resolve prev_close from cache first; backfill missing symbols calmly to avoid 429 bursts
    prev_closes = {}
    missing_codes = []
    now = time.time()
    with _cache_lock:
        for c in code_list:
            cached = _prev_close_cache.get(c)
            if cached and now < cached.get("expires_at", 0.0):
                prev_closes[c] = cached.get("price")
            else:
                missing_codes.append(c)

    if missing_codes:
        if len(missing_codes) <= 2:
            for c in missing_codes:
                res = fetch_prev_close(c)
                if res is not None:
                    prev_closes[c] = res
        else:
            _schedule_prev_close_backfill(missing_codes)

    for c in code_list:
        if c not in results:
            continue
        p_val = results[c]["price"]
        prev_close = prev_closes.get(c)
        if prev_close is None:
            existing_base = results[c].get("base_price")
            if existing_base and existing_base > 0 and existing_base != 72000.0 and existing_base != 210.0:
                prev_close = existing_base
        base_p = prev_close or p_val
        results[c]["base_price"] = base_p
        is_us = results[c]["currency"] == "USD" or not c.isdigit()
        c_val = round(p_val - base_p, 2 if is_us else 0)
        cr_val = round((c_val / base_p * 100), 2) if base_p else 0.0
        results[c]["change"] = c_val
        results[c]["change_rate"] = cr_val

    with _cache_lock:
        for c, q in results.items():
            _quote_cache[c] = q

    _last_rest_quote_sync = time.time()

    return results


def parse_session_status(raw: str) -> str:
    s = (raw or "").upper().strip()
    if "PRE" in s:
        return "PRE"
    if "REG" in s:
        return "REG"
    if "POST" in s:
        return "POST"
    if "CLOSE" in s:
        return "CLOSE"
    return "REG"


# -----------------------------------------------------------------------------
# WebSocket Streaming & Tick Broadcast
# -----------------------------------------------------------------------------

def broadcast_tick_update(tick_data: Dict[str, Any]) -> None:
    code = tick_data.get("code") or tick_data.get("symbol")
    if not code:
        return

    with _cache_lock:
        existing = _quote_cache.get(code)
        old_price = float(existing.get("price", 0.0)) if existing and existing.get("price") is not None else None

    new_price = tick_data.get("price")
    if new_price is not None:
        new_p = float(new_price)
        if "prev_price" not in tick_data and old_price is not None and old_price > 0:
            tick_data["prev_price"] = old_price
        if "tick_diff" not in tick_data:
            ref_p = tick_data.get("prev_price")
            tick_data["tick_diff"] = round(new_p - float(ref_p), 4) if (ref_p is not None and float(ref_p) > 0) else 0.0

    now = time.time()
    is_silent = bool(tick_data.get("silent"))
    if not is_silent and now - _last_broadcast_time.get(code, 0.0) < 0.1:
        with _cache_lock:
            if code in _quote_cache:
                _quote_cache[code].update(tick_data)
            else:
                _quote_cache[code] = tick_data
        return
    if not is_silent:
        _last_broadcast_time[code] = now

    with _cache_lock:
        if code in _quote_cache:
            _quote_cache[code].update(tick_data)
        else:
            _quote_cache[code] = tick_data

    # 1. Native pywebview evaluate_js push
    if _widget_window:
        try:
            payload_str = json.dumps(tick_data, ensure_ascii=False)
            _widget_window.evaluate_js(f"window.onStockTickUpdate && window.onStockTickUpdate({payload_str})")
        except Exception:
            pass

    # 2. Eel RPC broadcast
    try:
        if hasattr(eel, "onStockTickUpdate"):
            eel.onStockTickUpdate(tick_data)()
    except Exception:
        pass


def _build_ws_subscription_payload(conf: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Builds Toss WebSocket full-replace subscription payload (max 100 topics)."""
    if conf is None:
        conf = load_stock_config()

    market_map: Dict[str, str] = {}
    all_codes = set()

    for w in conf.get("watchlist", []):
        code = str(w.get("code") or "").strip().upper()
        if code:
            all_codes.add(code)
            mkt = str(w.get("market") or "").strip().upper()
            if mkt in ("KR", "US"):
                market_map[code] = mkt

    for g in conf.get("groups", []):
        for c in g.get("codes", []):
            code = str(c or "").strip().upper()
            if code:
                all_codes.add(code)

    symbols = sorted(all_codes)
    if len(symbols) > 100:
        logger.log_warn("StockService", f"WebSocket subscription capped at 100 symbols (requested {len(symbols)})")
        symbols = symbols[:100]

    kr_codes = [s for s in symbols if market_map.get(s) == "KR" or (s not in market_map and s.isdigit())]
    us_codes = [s for s in symbols if s not in kr_codes]

    sub_list: List[Dict[str, Any]] = []
    if us_codes:
        sub_list.append({"type": "trade:us", "codes": us_codes})
    if kr_codes:
        sub_list.append({"type": "trade:kr", "codes": kr_codes})
    return sub_list


def _ws_ping_worker(ws: Any, ping_stop: threading.Event) -> None:
    """Sends Toss plain-text PING every 55s to stay well within 180s client idle timeout."""
    while not ping_stop.wait(55.0):
        if _stop_streaming_event.is_set() or _is_paused:
            break
        try:
            ws.send("PING")
        except Exception:
            break


def _resync_quotes_on_reconnect() -> None:
    """Refreshes REST quote snapshot after WebSocket (re)connect since WS gives no initial snapshot."""
    try:
        if time.time() - _last_rest_quote_sync < 2.0:
            return
        conf = load_stock_config()
        watchlist = conf.get("watchlist", [])
        if not watchlist:
            return
        quotes = fetch_initial_prices(watchlist)
        for q in quotes.values():
            broadcast_tick_update(q)
    except Exception as e:
        logger.log_warn("StockService", f"Reconnect REST resync failed: {e}")


def update_ws_subscriptions() -> bool:
    """Dynamically sends updated trade subscriptions (KR & US) to active WebSocket."""
    global _active_ws
    sub_list = _build_ws_subscription_payload()

    with _stream_lock:
        ws = _active_ws
        paused = _is_paused

    if ws:
        try:
            ws.send(json.dumps(sub_list))
            logger.log_info("StockService", f"Dynamic subscription updated: {sub_list}")
            return True
        except Exception as e:
            logger.log_warn("StockService", f"Failed to send dynamic subscription: {e}")
            with _stream_lock:
                if _active_ws is ws:
                    _active_ws = None
            try:
                ws.close()
            except Exception:
                pass
            if not paused and sub_list:
                resume_streaming()
            return False
    else:
        if not paused and sub_list:
            resume_streaming()
        return False


def _streaming_worker():
    global _is_streaming_active, _backoff_delay, _active_ws, _consecutive_ws_failures
    logger.log_info("StockService", "Stock streaming background thread started")

    try:
        while not _stop_streaming_event.is_set():
            if _is_paused:
                _wake_event.clear()
                if _is_paused and not _stop_streaming_event.is_set():
                    _wake_event.wait(timeout=1.0)
                continue

            token = get_valid_token(min_ttl=120.0)
            if not token:
                _wake_event.clear()
                _wake_event.wait(timeout=3.0)
                continue

            conf = load_stock_config()
            sub_list = _build_ws_subscription_payload(conf)
            if not sub_list:
                _wake_event.clear()
                _wake_event.wait(timeout=3.0)
                continue

            try:
                import websocket
                has_ws = True
            except ImportError:
                has_ws = False

            if not has_ws:
                # REST polling fallback when websocket-client is unavailable (fixed 5s interval, no backoff escalation)
                try:
                    quotes = fetch_initial_prices(conf.get("watchlist", []))
                    for q in quotes.values():
                        broadcast_tick_update(q)
                except Exception as e:
                    logger.log_warn("StockService", f"REST polling fallback error: {e}")
                _wake_event.clear()
                if not _is_paused and not _stop_streaming_event.is_set():
                    _wake_event.wait(timeout=5.0)
                continue

            conn_state = {
                "opened": False,
                "auth_error": False,
                "forbidden_error": False,
                "server_shutdown": False,
                "ping_stop": threading.Event()
            }

            try:
                ws_url = "wss://openapi-ws.tossinvest.com/ws/v1"
                ws_token = token
                headers = [f"Authorization: Bearer {ws_token}"]

                def on_message(ws, msg):
                    try:
                        data = json.loads(msg)
                        msg_type = data.get("type")

                        if msg_type == "pong":
                            return

                        if msg_type == "subscriptions":
                            rejected = data.get("rejected") or []
                            if rejected:
                                logger.log_warn("StockService", f"WS subscription partial reject: {rejected}")
                            return

                        if msg_type == "error":
                            err_obj = data.get("error") or {}
                            err_code = str(data.get("code") or (err_obj.get("code") if isinstance(err_obj, dict) else "") or "")
                            err_msg = str(data.get("message") or (err_obj.get("message") if isinstance(err_obj, dict) else err_obj) or "")
                            if err_code == "auth-revoked":
                                logger.log_warn("StockService", f"WS auth revoked ({err_msg}), refreshing token and reconnecting")
                                conn_state["auth_error"] = True
                                invalidate_access_token(ws_token, reason="ws auth-revoked")
                                try:
                                    ws.close()
                                except Exception:
                                    pass
                            elif err_code == "server-shutdown":
                                logger.log_info("StockService", "WS server shutdown notice received, reconnecting")
                                conn_state["server_shutdown"] = True
                                try:
                                    ws.close()
                                except Exception:
                                    pass
                            else:
                                logger.log_warn("StockService", f"WS error frame [{err_code}]: {err_msg}")
                            return

                        if msg_type == "message":
                            topic = data.get("topic", "")
                            code = topic.split(":")[-1]
                            trade = data.get("data", {})
                            if code and trade:
                                p_val = float(trade.get("price", 0.0))
                                with _cache_lock:
                                    prev = dict(_quote_cache.get(code, {}))
                                    prev_close_cached = _prev_close_cache.get(code, {}).get("price")

                                curr = trade.get("currency", prev.get("currency") or ("USD" if not code.isdigit() else "KRW"))
                                mkt = "KR" if curr == "KRW" or prev.get("market") == "KR" or code.isdigit() else "US"

                                prev_p = float(prev.get("price", 0.0)) if prev.get("price") is not None else p_val
                                tick_diff = round(p_val - prev_p, 4) if prev_p > 0 else 0.0

                                base_p = float(prev.get("base_price", 0.0))
                                if base_p <= 0:
                                    base_p = float(prev_close_cached or p_val)
                                c_val = round(p_val - base_p, 2 if mkt == "US" else 0)
                                cr_val = round((c_val / base_p * 100), 2) if base_p else 0.0

                                now_h = (time.gmtime().tm_hour + 9) % 24
                                now_m = time.gmtime().tm_min
                                now_t = now_h * 60 + now_m
                                if mkt == "US":
                                    if 18 * 60 <= now_t < 23 * 60 + 30:
                                        sess = "PRE"
                                    elif now_t >= 23 * 60 + 30 or now_t < 6 * 60:
                                        sess = "REG"
                                    elif 6 * 60 <= now_t < 9 * 60 + 50:
                                        sess = "POST"
                                    else:
                                        sess = "CLOSE"
                                else:
                                    sess = "REG" if (9 * 60 <= now_t <= 15 * 60 + 30) else "CLOSE"

                                tick = {
                                    "code": code,
                                    "price": p_val,
                                    "prev_price": prev_p if prev_p > 0 else p_val,
                                    "tick_diff": tick_diff,
                                    "change": c_val,
                                    "change_rate": cr_val,
                                    "session": sess,
                                    "currency": curr,
                                    "formatted_price": f"{int(p_val):,}원" if mkt == "KR" else f"${p_val:,.2f}"
                                }
                                broadcast_tick_update(tick)
                    except Exception as ex:
                        logger.log_warn("StockService", f"WS tick parse error: {ex}")

                def on_open(ws):
                    global _backoff_delay, _active_ws, _consecutive_ws_failures
                    conn_state["opened"] = True
                    _backoff_delay = 1.0
                    _consecutive_ws_failures = 0
                    with _stream_lock:
                        _active_ws = ws
                    update_ws_subscriptions()
                    threading.Thread(
                        target=_ws_ping_worker,
                        args=(ws, conn_state["ping_stop"]),
                        name="StockWSPingThread",
                        daemon=True
                    ).start()
                    threading.Thread(
                        target=_resync_quotes_on_reconnect,
                        name="StockReconnectResyncThread",
                        daemon=True
                    ).start()

                def on_close(ws, status=None, msg=None):
                    global _active_ws
                    conn_state["ping_stop"].set()
                    with _stream_lock:
                        if _active_ws is ws:
                            _active_ws = None
                    msg_str = str(msg or "")
                    if status == 401 or "401" in msg_str or "auth-revoked" in msg_str.lower():
                        conn_state["auth_error"] = True
                        invalidate_access_token(ws_token, reason=f"ws close {status or msg_str}")
                    if not _is_paused and not _stop_streaming_event.is_set():
                        logger.log_info("StockService", f"WebSocket closed: status={status}, msg={msg}")

                def on_error(ws, err):
                    global _active_ws
                    with _stream_lock:
                        if _active_ws is ws:
                            _active_ws = None
                    err_str = str(err or "")
                    err_lower = err_str.lower()
                    if any(k in err_lower for k in ("401", "unauthorized", "auth-revoked")):
                        conn_state["auth_error"] = True
                        invalidate_access_token(ws_token, reason="ws error 401")
                    elif "403" in err_str or "forbidden" in err_lower:
                        conn_state["forbidden_error"] = True
                    if not _is_paused and not _stop_streaming_event.is_set():
                        if conn_state["forbidden_error"]:
                            logger.log_warn(
                                "StockService",
                                f"WebSocket HTTP 403 Forbidden (허용 공인 IP·VPN·네트워크 상태를 확인하세요): {err_str}"
                            )
                        else:
                            logger.log_warn("StockService", f"WebSocket error: {err_str}")

                ws_app = websocket.WebSocketApp(
                    ws_url,
                    header=headers,
                    on_open=on_open,
                    on_message=on_message,
                    on_error=on_error,
                    on_close=on_close
                )
                ws_app.run_forever(sslopt={"cert_reqs": ssl.CERT_NONE}, ping_interval=20, ping_timeout=10)
            except Exception as e:
                if not _is_paused and not _stop_streaming_event.is_set():
                    logger.log_warn("StockService", f"WebSocket connection failed: {e}")
            finally:
                conn_state["ping_stop"].set()
                with _stream_lock:
                    _active_ws = None

            if _stop_streaming_event.is_set() or _is_paused:
                continue

            if conn_state["auth_error"]:
                invalidate_access_token(token, reason="ws auth_error")

            if conn_state["forbidden_error"]:
                _backoff_delay = max(_backoff_delay, 10.0)

            if conn_state["server_shutdown"]:
                _backoff_delay = 1.0

            if not conn_state["opened"]:
                _consecutive_ws_failures += 1
                if _consecutive_ws_failures >= 2:
                    try:
                        quotes = fetch_initial_prices(conf.get("watchlist", []))
                        for q in quotes.values():
                            broadcast_tick_update(q)
                    except Exception:
                        pass

            wait_sec = _backoff_delay + random.uniform(0.0, 0.5)
            _wake_event.clear()
            if not _is_paused and not _stop_streaming_event.is_set():
                _wake_event.wait(timeout=wait_sec)
            _backoff_delay = min(30.0, _backoff_delay * 2.0)
    finally:
        with _stream_lock:
            _is_streaming_active = False
            _active_ws = None


def pause_streaming() -> None:
    global _is_paused, _active_ws
    with _stream_lock:
        _is_paused = True
        ws = _active_ws
        _active_ws = None
    _wake_event.set()
    if ws:
        try:
            ws.close()
        except Exception:
            pass
    logger.log_info("StockService", "Stock streaming paused (widget collapsed)")


def resume_streaming() -> None:
    global _is_paused, _is_streaming_active, _ws_thread, _backoff_delay, _consecutive_ws_failures
    with _stream_lock:
        _is_paused = False
        _backoff_delay = 1.0
        _consecutive_ws_failures = 0
        _stop_streaming_event.clear()
        if not _is_streaming_active or _ws_thread is None or not _ws_thread.is_alive():
            _ws_thread = threading.Thread(target=_streaming_worker, name="StockStreamingThread", daemon=True)
            _is_streaming_active = True
            _ws_thread.start()
    _wake_event.set()
    logger.log_info("StockService", "Stock streaming resumed (widget expanded)")


def stop_streaming() -> None:
    """Gracefully shuts down WebSocket streaming thread and socket on application exit."""
    global _is_paused, _is_streaming_active, _active_ws
    with _stream_lock:
        _is_paused = True
        _is_streaming_active = False
        _stop_streaming_event.set()
        ws = _active_ws
        _active_ws = None
    _wake_event.set()
    if ws:
        try:
            ws.close()
        except Exception:
            pass


def init_stock_service(edge_manager: Any = None) -> None:
    """Safe startup initializer for stock service."""
    if edge_manager and hasattr(edge_manager, "window"):
        set_widget_window(edge_manager.window)

    def _preload():
        try:
            load_stock_config()
            master = load_master_stocks()
            fetch_exchange_rates()
            # If master cache only has default small list, trigger sync
            if len(master) <= len(DEFAULT_MASTER_STOCKS) and get_valid_token():
                sync_master_stocks_background()
        except Exception as e:
            logger.log_warn("StockService", f"Stock service preload error: {e}")

    threading.Thread(target=_preload, name="StockPreloadThread", daemon=True).start()


# -----------------------------------------------------------------------------
# Eel Exposed Functions
# -----------------------------------------------------------------------------

@eel.expose
def get_stock_dashboard_data() -> Dict[str, Any]:
    """Returns FX rates, watchlist quotes, and API configuration flag."""
    conf = load_stock_config()
    cid = conf.get("client_id", "").strip()
    csec = conf.get("client_secret", "").strip()
    api_configured = bool(cid and csec)

    fx_data = fetch_exchange_rates()
    watchlist = conf.get("watchlist", DEFAULT_WATCHLIST)
    quotes_map = fetch_initial_prices(watchlist)

    items = []
    for w in watchlist:
        code = w.get("code")
        if code in quotes_map:
            items.append(quotes_map[code])
        else:
            items.append({
                "code": code,
                "name": w.get("name", code),
                "market": w.get("market", "KR"),
                "price": 0.0,
                "change": 0.0,
                "change_rate": 0.0,
                "session": "CLOSE",
                "currency": "KRW" if w.get("market") == "KR" else "USD",
                "formatted_price": "--"
            })

    return {
        "status": "success",
        "api_configured": api_configured,
        "fx": fx_data,
        "watchlist": items,
        "groups": conf.get("groups", []),
        "active_group_id": conf.get("active_group_id", "g_default")
    }


@eel.expose
def save_stock_api_keys(client_id: str, client_secret: str) -> Dict[str, Any]:
    """Saves API credentials and validates OAuth token."""
    cid = (client_id or "").strip()
    csec = (client_secret or "").strip()

    conf = load_stock_config()
    conf["client_id"] = cid
    conf["client_secret"] = csec
    save_stock_config(conf)

    if not cid or not csec:
        return {"success": True, "message": "API 키가 삭제되었습니다.", "configured": False}

    token = _fetch_access_token(cid, csec)
    if token:
        sync_master_stocks_background()
        resume_streaming()
        return {"success": True, "message": "Toss Open API 인증에 성공하였습니다.", "configured": True}
    else:
        return {"success": False, "error": "인증에 실패하였습니다. Client ID/Secret 및 허용 공인 IP를 확인해주세요."}


@eel.expose
def add_stock_group(name: str) -> Dict[str, Any]:
    """Create unique group ID g_<timestamp>, add to groups, set as active, save config."""
    clean_name = (name or "").strip()
    conf = load_stock_config()
    groups = conf.get("groups", [])

    if not clean_name:
        clean_name = f"그룹 {len(groups) + 1}"

    group_id = f"g_{int(time.time() * 1000)}"
    new_group = {
        "id": group_id,
        "name": clean_name,
        "codes": []
    }
    groups.append(new_group)
    conf["groups"] = groups
    conf["active_group_id"] = group_id
    save_stock_config(conf)

    logger.log_info("StockService", f"Added stock group: {clean_name} ({group_id})")
    return {
        "success": True,
        "groups": conf["groups"],
        "active_group_id": group_id,
        "new_group": new_group
    }


@eel.expose
def rename_stock_group(group_id: str, new_name: str) -> Dict[str, Any]:
    """Rename specified group, save config, return success."""
    clean_name = (new_name or "").strip()
    if not clean_name:
        return {"success": False, "error": "그룹 이름을 입력해주세요."}

    conf = load_stock_config()
    groups = conf.get("groups", [])
    target = next((g for g in groups if g.get("id") == group_id), None)
    if not target:
        return {"success": False, "error": "해당 그룹을 찾을 수 없습니다."}

    target["name"] = clean_name
    save_stock_config(conf)
    logger.log_info("StockService", f"Renamed stock group {group_id} to {clean_name}")
    return {
        "success": True,
        "groups": conf["groups"],
        "active_group_id": conf.get("active_group_id")
    }


@eel.expose
def remove_stock_group(group_id: str) -> Dict[str, Any]:
    """Prevent deleting the last group. If deleting active group, switch active. Remove group, save config."""
    conf = load_stock_config()
    groups = conf.get("groups", [])

    if len(groups) <= 1:
        return {"success": False, "error": "최소 1개의 그룹은 유지되어야 합니다."}

    target = next((g for g in groups if g.get("id") == group_id), None)
    if not target:
        return {"success": False, "error": "해당 그룹을 찾을 수 없습니다."}

    conf["groups"] = [g for g in groups if g.get("id") != group_id]

    if conf.get("active_group_id") == group_id:
        conf["active_group_id"] = conf["groups"][0]["id"]

    all_active_codes = {c for g in conf["groups"] for c in g.get("codes", [])}
    removed_codes = set(target.get("codes", [])) - all_active_codes
    if removed_codes:
        conf["watchlist"] = [s for s in conf.get("watchlist", []) if s.get("code") not in removed_codes]
        with _cache_lock:
            for rc in removed_codes:
                _quote_cache.pop(rc, None)

    save_stock_config(conf)
    update_ws_subscriptions()
    logger.log_info("StockService", f"Removed stock group: {group_id}")
    return {
        "success": True,
        "groups": conf["groups"],
        "active_group_id": conf["active_group_id"]
    }


@eel.expose
def set_active_stock_group(group_id: str) -> Dict[str, Any]:
    """Set active_group_id = group_id, save config, return success."""
    conf = load_stock_config()
    groups = conf.get("groups", [])
    if not any(g.get("id") == group_id for g in groups):
        return {"success": False, "error": "해당 그룹을 찾을 수 없습니다."}

    conf["active_group_id"] = group_id
    save_stock_config(conf)
    return {"success": True, "active_group_id": group_id}


@eel.expose
def add_stock_symbol(code: str, name: str, market: str, group_id: Optional[str] = None) -> Dict[str, Any]:
    """Adds a new stock symbol to watchlist pool and specific group."""
    clean_code = (code or "").strip().upper()
    clean_name = (name or clean_code).strip()
    clean_market = (market or ("KR" if clean_code.isdigit() else "US")).strip().upper()

    if not clean_code:
        return {"success": False, "error": "종목 코드가 유효하지 않습니다."}

    conf = load_stock_config()
    groups = conf.get("groups", [])
    if not groups:
        groups = [{"id": "g_default", "name": "기본", "codes": []}]
        conf["groups"] = groups

    gid = group_id or conf.get("active_group_id") or groups[0]["id"]
    target_group = next((g for g in groups if g.get("id") == gid), groups[0])

    if clean_code in target_group.get("codes", []):
        return {"success": False, "error": "이미 해당 그룹에 등록되어 있습니다."}

    target_group.setdefault("codes", []).append(clean_code)

    watchlist = conf.get("watchlist", [])
    new_item = {"code": clean_code, "name": clean_name, "market": clean_market}
    if not any(item.get("code") == clean_code for item in watchlist):
        watchlist.append(new_item)
    conf["watchlist"] = watchlist
    save_stock_config(conf)

    quotes = fetch_initial_prices([new_item])
    quote_data = quotes.get(clean_code, new_item)

    update_ws_subscriptions()
    return {
        "success": True,
        "item": quote_data,
        "group_id": target_group.get("id"),
        "groups": conf["groups"]
    }


@eel.expose
def remove_stock_symbol(code: str, group_id: Optional[str] = None) -> Dict[str, Any]:
    """Removes a stock symbol from group, and from watchlist pool if not in any group."""
    clean_code = (code or "").strip().upper()
    conf = load_stock_config()
    groups = conf.get("groups", [])

    gid = group_id or conf.get("active_group_id")
    target_group = next((g for g in groups if g.get("id") == gid), None) if gid else None

    found_in_group = False
    if target_group:
        if clean_code in target_group.get("codes", []):
            target_group["codes"].remove(clean_code)
            found_in_group = True
    else:
        for g in groups:
            if clean_code in g.get("codes", []):
                g["codes"].remove(clean_code)
                found_in_group = True

    if not found_in_group and not any(item.get("code") == clean_code for item in conf.get("watchlist", [])):
        return {"success": False, "error": "해당 종목을 찾을 수 없습니다."}

    all_codes = {c for g in groups for c in g.get("codes", [])}
    if clean_code not in all_codes:
        conf["watchlist"] = [item for item in conf.get("watchlist", []) if item.get("code") != clean_code]
        with _cache_lock:
            _quote_cache.pop(clean_code, None)

    save_stock_config(conf)
    update_ws_subscriptions()
    return {
        "success": True,
        "code": clean_code,
        "group_id": gid,
        "groups": conf["groups"]
    }


@eel.expose
def reorder_stock_group_codes(group_id: str, ordered_codes: List[str]) -> Dict[str, Any]:
    """Reorders stock symbol codes within the specified group and persists config."""
    if not isinstance(ordered_codes, list):
        return {"success": False, "error": "잘못된 순서 데이터입니다."}

    conf = load_stock_config()
    groups = conf.get("groups", [])
    if not groups:
        return {"success": False, "error": "등록된 그룹이 없습니다."}

    gid = group_id or conf.get("active_group_id") or groups[0].get("id")
    target_group = next((g for g in groups if g.get("id") == gid), None)
    if not target_group:
        return {"success": False, "error": "해당 그룹을 찾을 수 없습니다."}

    existing_codes = list(target_group.get("codes", []))
    existing_set = set(existing_codes)

    new_codes: List[str] = []
    seen = set()
    for raw_code in ordered_codes:
        code = str(raw_code or "").strip().upper()
        if code in existing_set and code not in seen:
            new_codes.append(code)
            seen.add(code)

    for code in existing_codes:
        if code not in seen:
            new_codes.append(code)
            seen.add(code)

    target_group["codes"] = new_codes
    save_stock_config(conf)
    logger.log_info("StockService", f"Reordered stock group {gid}: {new_codes}")
    return {
        "success": True,
        "group_id": gid,
        "codes": new_codes,
        "groups": conf["groups"]
    }


@eel.expose
def search_stock_master(query: str) -> List[Dict[str, Any]]:
    """Searches stock master list by name or ticker using smart relevance scoring."""
    q = (query or "").strip().lower()
    if not q:
        return []

    master = load_master_stocks()
    scored = []
    for item in master:
        code = str(item.get("code", "")).lower()
        name = str(item.get("name", "")).lower()

        if code == q or name == q:
            score = 1000 - len(name)
        elif name.startswith(q) or code.startswith(q):
            score = 500 - len(name)
        elif q in name or q in code:
            score = 100 - len(name)
        else:
            continue

        scored.append((score, item))

    scored.sort(key=lambda x: x[0], reverse=True)
    results = [x[1] for x in scored[:10]]

    # Fallback to direct Toss API lookup if no local match and query resembles a symbol
    if not results and (q.isalnum() and len(q) <= 10):
        try:
            url = f"https://openapi.tossinvest.com/api/v1/stocks?symbols={urllib.parse.quote(query.strip().upper())}"
            d = _toss_api_get_json(url, timeout=2.0)
            if d:
                items = d.get('result', d.get('data', []))
                if isinstance(items, list) and items:
                    it = items[0]
                    results.append({
                        'code': it.get('symbol', query.strip().upper()),
                        'name': it.get('name', query.strip().upper()),
                        'market': it.get('market', 'KR' if query.isdigit() else 'US')
                    })
        except (_TossRateLimitError, _TossForbiddenError):
            pass
        except Exception as e:
            logger.log_debug("StockService", f"Direct stock lookup error: {e}")

    return results


@eel.expose
def refresh_stock_data() -> Dict[str, Any]:
    """Forces immediate FX and price quotes refresh without duplicate REST calls."""
    conf = load_stock_config()
    cid = conf.get("client_id", "").strip()
    csec = conf.get("client_secret", "").strip()
    api_configured = bool(cid and csec)

    fx_data = fetch_exchange_rates(force_refresh=True)
    watchlist = conf.get("watchlist", DEFAULT_WATCHLIST)
    quotes_map = fetch_initial_prices(watchlist, force_refresh=True)

    items = []
    for w in watchlist:
        code = w.get("code")
        if code in quotes_map:
            items.append(quotes_map[code])
        else:
            items.append({
                "code": code,
                "name": w.get("name", code),
                "market": w.get("market", "KR"),
                "price": 0.0,
                "change": 0.0,
                "change_rate": 0.0,
                "session": "CLOSE",
                "currency": "KRW" if w.get("market") == "KR" else "USD",
                "formatted_price": "--"
            })

    return {
        "status": "success",
        "api_configured": api_configured,
        "fx": fx_data,
        "watchlist": items,
        "groups": conf.get("groups", []),
        "active_group_id": conf.get("active_group_id", "g_default")
    }