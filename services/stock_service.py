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
import re
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
_cache_lock = threading.RLock()
_token_lock = threading.Lock()
_stream_lock = threading.Lock()
_market_calendar_lock = threading.Lock()
_toss_rate_lock = threading.Lock()
_prev_close_backfill_lock = threading.Lock()
_trend_backfill_lock = threading.Lock()

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
_trend_inflight: set = set()

_fx_cache: Dict[str, Any] = {"data": None, "expires_at": 0.0}
_quote_cache: Dict[str, Dict[str, Any]] = {}
_master_cache: List[Dict[str, Any]] = []
_prev_close_cache: Dict[str, Dict[str, Any]] = {}
_daily_trend_cache: Dict[str, Dict[str, Any]] = {}
_intraday_trend_cache: Dict[str, Dict[str, Any]] = {}
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

        if conf.get("connection_mode") not in ("local", "relay"):
            conf["connection_mode"] = "local"
            migrated = True
        if "relay_url" not in conf or not isinstance(conf.get("relay_url"), str):
            conf["relay_url"] = ""
            migrated = True
        if "relay_token" not in conf or not isinstance(conf.get("relay_token"), str):
            conf["relay_token"] = ""
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


# -----------------------------------------------------------------------------
# 5-Level Trend Engine (Swing: Daily MA5/MA20, Scalp: Intraday EMA5/EMA20)
# -----------------------------------------------------------------------------

TREND_EMOJI = {
    "strong_up": "🚀",
    "up": "📈",
    "neutral": "➖",
    "down": "📉",
    "strong_down": "🔻",
    "unknown": "·"
}

TREND_LABEL = {
    "strong_up": "강한 상승",
    "up": "상승",
    "neutral": "횡보",
    "down": "하락",
    "strong_down": "강한 하락",
    "unknown": "집계 중"
}


def _make_trend_obj(kind_label: str, level: str, detail: str = "") -> Dict[str, Any]:
    lv = level if level in TREND_EMOJI else "unknown"
    lbl = TREND_LABEL[lv]
    tip = f"{kind_label} 추세: {lbl} ({detail})" if detail else f"{kind_label} 추세: {lbl}"
    return {
        "level": lv,
        "emoji": TREND_EMOJI[lv],
        "label": lbl,
        "tooltip": tip
    }


def _format_trend_price(val: float, is_krw: bool) -> str:
    if is_krw:
        return f"{round(val):,}원"
    return f"${val:,.2f}"


def _compute_ema_series(closes: List[float], period: int) -> Optional[float]:
    if not closes:
        return None
    k = 2.0 / (period + 1.0)
    ema = float(closes[0])
    for val in closes[1:]:
        ema = float(val) * k + ema * (1.0 - k)
    return ema


def _fetch_daily_trend_base(symbol: str) -> Optional[Dict[str, Any]]:
    """Fetch prior daily closes via Naver (KR) or Yahoo (US) without consuming Toss quota."""
    clean = symbol.strip().upper()
    is_kr = clean.isdigit() or clean.endswith(".KS") or clean.endswith(".KQ")
    prior_closes: List[float] = []

    try:
        if is_kr:
            clean_sym = clean.replace(".KS", "").replace(".KQ", "")
            url = f"https://fchart.stock.naver.com/sise.nhn?symbol={urllib.parse.quote(clean_sym)}&timeframe=day&count=25&requestType=0"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                body = resp.read().decode("euc-kr", errors="replace")
            rows = re.findall(r'data="([^"]+)"', body)
            parsed = []
            kst_today = time.strftime("%Y%m%d", time.gmtime(time.time() + 9 * 3600))
            for row in rows:
                parts = row.split("|")
                if len(parts) >= 5:
                    try:
                        d_str = parts[0].strip()
                        c_val = float(parts[4])
                        if c_val > 0:
                            parsed.append((d_str, c_val))
                    except Exception:
                        pass
            if parsed and parsed[-1][0] == kst_today and len(parsed) >= 2:
                parsed = parsed[:-1]
            prior_closes = [p[1] for p in parsed]
        else:
            yahoo_sym = clean.replace(".", "-")
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_sym)}?range=1mo&interval=1d"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=3.0, context=_SSL_CTX) as resp:
                ydata = json.loads(resp.read().decode("utf-8"))
            res_list = ydata.get("chart", {}).get("result") or []
            if res_list:
                res0 = res_list[0]
                meta = res0.get("meta", {})
                ts_list = res0.get("timestamp") or []
                closes = ((res0.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
                us_today = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 5 * 3600))
                parsed = []
                for ts, c in zip(ts_list, closes):
                    if c is not None and float(c) > 0:
                        d_str = time.strftime("%Y-%m-%d", time.gmtime(ts - 5 * 3600))
                        parsed.append((d_str, float(c)))
                if parsed and parsed[-1][0] == us_today and len(parsed) >= 2:
                    parsed = parsed[:-1]
                prior_closes = [p[1] for p in parsed]

                # Opportunistically warm prev_close cache if absent
                prev_c = meta.get("previousClose") or meta.get("chartPreviousClose")
                if prev_c is not None and float(prev_c) > 0:
                    with _cache_lock:
                        if symbol not in _prev_close_cache:
                            _prev_close_cache[symbol] = {
                                "price": round(float(prev_c), 4),
                                "expires_at": time.time() + 3600.0
                            }
    except Exception as e:
        logger.log_debug("StockService", f"Daily trend fetch notice for {symbol}: {e}")
        return None

    if len(prior_closes) < 4:
        return None

    entry = {
        "sum4": sum(prior_closes[-4:]),
        "sum19": sum(prior_closes[-19:]) if len(prior_closes) >= 19 else None,
        "count": len(prior_closes),
        "expires_at": time.time() + 1800.0
    }
    with _cache_lock:
        _daily_trend_cache[symbol] = entry
    return entry


def _fetch_intraday_trend_base(symbol: str) -> Optional[Dict[str, Any]]:
    """Fetch recent 1m bars via Naver (KR) or Yahoo (US) to seed intraday EMA5/EMA20."""
    clean = symbol.strip().upper()
    is_kr = clean.isdigit() or clean.endswith(".KS") or clean.endswith(".KQ")
    closes: List[float] = []

    try:
        if is_kr:
            clean_sym = clean.replace(".KS", "").replace(".KQ", "")
            url = f"https://api.stock.naver.com/chart/domestic/item/{urllib.parse.quote(clean_sym)}/minute?periodType=dayCandle"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                arr = json.loads(resp.read().decode("utf-8"))
            if isinstance(arr, list):
                for bar in arr[-36:]:
                    val = bar.get("currentPrice")
                    if val is not None and float(val) > 0:
                        closes.append(float(val))
        else:
            yahoo_sym = clean.replace(".", "-")
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_sym)}?range=1d&interval=1m&includePrePost=true"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=3.0, context=_SSL_CTX) as resp:
                ydata = json.loads(resp.read().decode("utf-8"))
            res_list = ydata.get("chart", {}).get("result") or []
            if res_list:
                raw_closes = ((res_list[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
                closes = [float(c) for c in raw_closes if c is not None and float(c) > 0][-36:]
    except Exception as e:
        logger.log_debug("StockService", f"Intraday trend fetch notice for {symbol}: {e}")
        return None

    if len(closes) < 6:
        return None

    prior = closes[:-1] if len(closes) >= 7 else closes
    ema5_prev = _compute_ema_series(prior[-25:], 5)
    ema20_prev = _compute_ema_series(prior[-35:], 20)
    if ema5_prev is None or ema20_prev is None:
        return None

    entry = {
        "ema5_prev": ema5_prev,
        "ema20_prev": ema20_prev,
        "bar_count": len(prior),
        "expires_at": time.time() + 90.0
    }
    with _cache_lock:
        _intraday_trend_cache[symbol] = entry
    return entry


def compute_swing_trend(symbol: str, price: float, is_krw: bool) -> Dict[str, Any]:
    if not price or price <= 0:
        return _make_trend_obj("스윙(일봉)", "unknown")

    with _cache_lock:
        base = _daily_trend_cache.get(symbol)
    if not base or base.get("sum4") is None:
        return _make_trend_obj("스윙(일봉)", "unknown", "일봉 집계 중")

    ma5 = (float(base["sum4"]) + price) / 5.0
    sum19 = base.get("sum19")
    ma20 = (float(sum19) + price) / 20.0 if sum19 is not None else None

    band = 0.002  # ±0.2% 중립 밴드
    if ma20 is not None:
        detail = f"현재 {_format_trend_price(price, is_krw)} · 5일 {_format_trend_price(ma5, is_krw)} · 20일 {_format_trend_price(ma20, is_krw)}"
        if price > ma5 * (1.0 + band) and ma5 > ma20:
            level = "strong_up"
        elif price > ma5 * (1.0 + band) or (price > ma20 * (1.0 + band) and price >= ma5 * (1.0 - band)):
            level = "up"
        elif price < ma5 * (1.0 - band) and ma5 < ma20:
            level = "strong_down"
        elif price < ma5 * (1.0 - band) or (price < ma20 * (1.0 - band) and price <= ma5 * (1.0 + band)):
            level = "down"
        else:
            level = "neutral"
    else:
        detail = f"현재 {_format_trend_price(price, is_krw)} · 5일 {_format_trend_price(ma5, is_krw)}"
        if price > ma5 * 1.005:
            level = "strong_up"
        elif price > ma5 * (1.0 + band):
            level = "up"
        elif price < ma5 * 0.995:
            level = "strong_down"
        elif price < ma5 * (1.0 - band):
            level = "down"
        else:
            level = "neutral"

    return _make_trend_obj("스윙(일봉)", level, detail)


def compute_scalp_trend(symbol: str, price: float, is_krw: bool) -> Dict[str, Any]:
    if not price or price <= 0:
        return _make_trend_obj("단타(1분봉)", "unknown")

    with _cache_lock:
        base = _intraday_trend_cache.get(symbol)
    if not base or base.get("ema5_prev") is None or base.get("ema20_prev") is None:
        return _make_trend_obj("단타(1분봉)", "unknown", "분봉 집계 중")

    k5 = 2.0 / 6.0
    k20 = 2.0 / 21.0
    ema5_now = price * k5 + float(base["ema5_prev"]) * (1.0 - k5)
    ema20_now = price * k20 + float(base["ema20_prev"]) * (1.0 - k20)
    if ema20_now <= 0:
        return _make_trend_obj("단타(1분봉)", "unknown")

    diff_pct = (ema5_now - ema20_now) / ema20_now * 100.0
    detail = f"EMA5 {_format_trend_price(ema5_now, is_krw)} · EMA20 {_format_trend_price(ema20_now, is_krw)} ({diff_pct:+.2f}%)"

    if diff_pct >= 0.35 and price >= ema5_now:
        level = "strong_up"
    elif diff_pct >= 0.10:
        level = "up"
    elif diff_pct <= -0.35 and price <= ema5_now:
        level = "strong_down"
    elif diff_pct <= -0.10:
        level = "down"
    else:
        level = "neutral"

    return _make_trend_obj("단타(1분봉)", level, detail)


def attach_trends_to_quote(symbol: str, quote_obj: Dict[str, Any]) -> None:
    if not symbol or not isinstance(quote_obj, dict):
        return
    try:
        price = float(quote_obj.get("price", 0.0) or 0.0)
    except Exception:
        price = 0.0
    curr = quote_obj.get("currency", "KRW" if symbol.isdigit() else "USD")
    is_krw = curr == "KRW" or quote_obj.get("market") == "KR" or symbol.isdigit()
    if "swing_trend" not in quote_obj:
        quote_obj["swing_trend"] = compute_swing_trend(symbol, price, is_krw)
    if "scalp_trend" not in quote_obj:
        quote_obj["scalp_trend"] = compute_scalp_trend(symbol, price, is_krw)


def _schedule_trend_backfill(codes: List[str]) -> None:
    """Refresh stale daily/intraday trend bases in background and push silent UI updates."""
    now = time.time()
    needed = []
    with _cache_lock:
        for c in codes:
            if not c:
                continue
            d_c = _daily_trend_cache.get(c)
            i_c = _intraday_trend_cache.get(c)
            need_d = not d_c or now >= d_c.get("expires_at", 0.0)
            need_i = not i_c or now >= i_c.get("expires_at", 0.0)
            if need_d or need_i:
                needed.append((c, need_d, need_i))

    to_fetch = []
    with _trend_backfill_lock:
        for c, nd, ni in needed:
            if c not in _trend_inflight:
                _trend_inflight.add(c)
                to_fetch.append((c, nd, ni))

    if not to_fetch:
        return

    def _worker():
        try:
            for c, need_d, need_i in to_fetch:
                if _stop_streaming_event.is_set():
                    break
                updated = False
                if need_d and _fetch_daily_trend_base(c):
                    updated = True
                if need_i and _fetch_intraday_trend_base(c):
                    updated = True

                if updated:
                    with _cache_lock:
                        q = _quote_cache.get(c)
                        q_snap = dict(q) if q else None
                    if q_snap:
                        p_val = float(q_snap.get("price", 0.0) or 0.0)
                        curr = q_snap.get("currency", "KRW" if c.isdigit() else "USD")
                        is_krw = curr == "KRW" or q_snap.get("market") == "KR" or c.isdigit()
                        swing_t = compute_swing_trend(c, p_val, is_krw)
                        scalp_t = compute_scalp_trend(c, p_val, is_krw)
                        with _cache_lock:
                            if c in _quote_cache:
                                _quote_cache[c]["swing_trend"] = swing_t
                                _quote_cache[c]["scalp_trend"] = scalp_t
                        payload = {
                            "code": c,
                            "price": p_val,
                            "prev_price": p_val,
                            "tick_diff": 0.0,
                            "change": q_snap.get("change", 0.0),
                            "change_rate": q_snap.get("change_rate", 0.0),
                            "session": q_snap.get("session", "REG"),
                            "currency": curr,
                            "formatted_price": q_snap.get("formatted_price"),
                            "swing_trend": swing_t,
                            "scalp_trend": scalp_t,
                            "silent": True
                        }
                        broadcast_tick_update(payload)
                time.sleep(0.04)
        finally:
            with _trend_backfill_lock:
                for c, _, _ in to_fetch:
                    _trend_inflight.discard(c)

    threading.Thread(target=_worker, name="StockTrendBackfillThread", daemon=True).start()


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
        results[c].pop("swing_trend", None)
        results[c].pop("scalp_trend", None)
        attach_trends_to_quote(c, results[c])

    with _cache_lock:
        for c, q in results.items():
            _quote_cache[c] = q

    _schedule_trend_backfill(code_list)

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
        attach_trends_to_quote(code, tick_data)

    now = time.time()
    is_silent = bool(tick_data.get("silent"))
    if not is_silent:
        swing_lvl = (tick_data.get("swing_trend") or {}).get("level")
        scalp_lvl = (tick_data.get("scalp_trend") or {}).get("level")
        if swing_lvl == "unknown" or scalp_lvl == "unknown":
            if now - _last_broadcast_time.get(f"__trend_{code}", 0.0) >= 90.0:
                _last_broadcast_time[f"__trend_{code}"] = now
                _schedule_trend_backfill([code])
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


def _normalize_relay_url(raw_url: str) -> str:
    url = (raw_url or "").strip().rstrip("/")
    if not url:
        return ""
    if url.startswith("wss://"):
        url = "https://" + url[6:]
    elif url.startswith("ws://"):
        url = "http://" + url[5:]
    elif not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url.rstrip("/")


def _is_relay_mode(conf: Optional[Dict[str, Any]] = None) -> bool:
    if conf is None:
        conf = load_stock_config()
    return conf.get("connection_mode") == "relay" and bool(str(conf.get("relay_url") or "").strip())


def _relay_ws_url(base_http_url: str, token: str = "") -> str:
    norm = _normalize_relay_url(base_http_url)
    if not norm:
        return ""
    if norm.startswith("https://"):
        ws_base = "wss://" + norm[8:]
    elif norm.startswith("http://"):
        ws_base = "ws://" + norm[7:]
    else:
        ws_base = "wss://" + norm
    ws_url = f"{ws_base}/ws/stream"
    if token:
        ws_url = f"{ws_url}?token={urllib.parse.quote(token)}"
    return ws_url


def _relay_http_json_request(
    method: str,
    path: str,
    conf: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: float = 4.0
) -> tuple:
    """Perform HTTP JSON call against configured relay server. Returns (data, error_str)."""
    if conf is None:
        conf = load_stock_config()
    base_url = _normalize_relay_url(conf.get("relay_url", ""))
    if not base_url:
        return None, "릴레이 서버 URL이 설정되지 않았습니다."

    clean_path = path if path.startswith("/") else f"/{path}"
    url = f"{base_url}{clean_path}"
    token = str(conf.get("relay_token") or "").strip()

    headers = {
        "Accept": "application/json",
        "User-Agent": "Util-Tools-Widget/1.0"
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    payload_bytes = None
    if body is not None:
        payload_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=payload_bytes, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
            raw = resp.read().decode("utf-8", errors="replace").strip()
            if not raw:
                return {}, None
            return json.loads(raw), None
    except urllib.error.HTTPError as e:
        err_msg = f"HTTP {e.code}"
        if e.code in (401, 403):
            err_msg = f"인증 실패 (HTTP {e.code})"
        return None, err_msg
    except Exception as e:
        return None, str(e)


def _build_relay_watchlist_payload(conf: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    if conf is None:
        conf = load_stock_config()

    meta_map: Dict[str, Dict[str, str]] = {}
    ordered_codes: List[str] = []

    for w in conf.get("watchlist", []):
        code = str(w.get("code") or "").strip().upper()
        if not code:
            continue
        mkt = str(w.get("market") or ("KR" if code.isdigit() else "US")).strip().upper()
        name = str(w.get("name") or code).strip()
        if code not in meta_map:
            ordered_codes.append(code)
        meta_map[code] = {"code": code, "name": name, "market": mkt}

    for g in conf.get("groups", []):
        for c in g.get("codes", []):
            code = str(c or "").strip().upper()
            if code and code not in meta_map:
                ordered_codes.append(code)
                meta_map[code] = {
                    "code": code,
                    "name": code,
                    "market": "KR" if code.isdigit() else "US"
                }

    return [meta_map[c] for c in ordered_codes]


def _sync_relay_watchlist(conf: Optional[Dict[str, Any]] = None, timeout: float = 3.0) -> bool:
    if conf is None:
        conf = load_stock_config()
    if not _is_relay_mode(conf):
        return False
    payload = {"watchlist": _build_relay_watchlist_payload(conf)}
    data, err = _relay_http_json_request("POST", "/api/watchlist", conf=conf, body=payload, timeout=timeout)
    if err:
        logger.log_debug("StockService", f"Relay watchlist sync notice: {err}")
        return False
    return data is not None


def _sync_relay_watchlist_background(conf: Optional[Dict[str, Any]] = None) -> None:
    snapshot_conf = dict(conf) if conf else load_stock_config()
    if not _is_relay_mode(snapshot_conf):
        return
    threading.Thread(
        target=_sync_relay_watchlist,
        args=(snapshot_conf, 3.0),
        name="StockRelayWatchlistSync",
        daemon=True
    ).start()


def _normalize_relay_quote_item(raw: Dict[str, Any], meta_fallback: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    code = str(raw.get("code") or raw.get("symbol") or "").strip().upper()
    if not code:
        return None

    fb = meta_fallback or {}
    market = str(raw.get("market") or fb.get("market") or ("KR" if code.isdigit() else "US")).strip().upper()
    curr = str(raw.get("currency") or ("KRW" if market == "KR" else "USD")).strip().upper()
    is_krw = curr == "KRW" or market == "KR" or code.isdigit()

    try:
        p_val = float(raw.get("price", raw.get("lastPrice", 0.0)) or 0.0)
    except Exception:
        p_val = 0.0

    try:
        base_p = float(raw.get("base_price", 0.0) or 0.0)
    except Exception:
        base_p = 0.0

    try:
        c_val = float(raw.get("change", 0.0) or 0.0)
    except Exception:
        c_val = 0.0

    try:
        cr_val = float(raw.get("change_rate", 0.0) or 0.0)
    except Exception:
        cr_val = 0.0

    formatted_p = raw.get("formatted_price")
    if not formatted_p:
        if p_val > 0:
            formatted_p = f"{int(p_val):,}원" if is_krw else f"${p_val:,.2f}"
        else:
            formatted_p = "--"

    item: Dict[str, Any] = {
        "code": code,
        "name": str(raw.get("name") or fb.get("name") or code),
        "market": market,
        "price": p_val,
        "base_price": base_p if base_p > 0 else p_val,
        "change": c_val,
        "change_rate": cr_val,
        "session": str(raw.get("session") or "REG").upper(),
        "currency": curr,
        "formatted_price": formatted_p
    }

    if isinstance(raw.get("swing_trend"), dict) and raw["swing_trend"].get("emoji"):
        item["swing_trend"] = raw["swing_trend"]
    if isinstance(raw.get("scalp_trend"), dict) and raw["scalp_trend"].get("emoji"):
        item["scalp_trend"] = raw["scalp_trend"]

    attach_trends_to_quote(code, item)
    return item


def _merge_relay_snapshot_payload(snap: Dict[str, Any], conf: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Normalize relay snapshot payload, update FX/quote caches, and return quotes_map + fx."""
    if conf is None:
        conf = load_stock_config()

    fx_data = snap.get("fx")
    if isinstance(fx_data, dict) and (fx_data.get("USD") or fx_data.get("JPY")):
        with _cache_lock:
            _fx_cache["data"] = fx_data
            _fx_cache["expires_at"] = time.time() + 60.0

    meta_by_code = {
        str(w.get("code") or "").strip().upper(): w
        for w in conf.get("watchlist", [])
        if w.get("code")
    }

    raw_items: List[Dict[str, Any]] = []
    if isinstance(snap.get("watchlist"), list):
        raw_items = snap["watchlist"]
    elif isinstance(snap.get("quotes"), dict):
        for k, v in snap["quotes"].items():
            if isinstance(v, dict):
                copy_v = dict(v)
                copy_v.setdefault("code", k)
                raw_items.append(copy_v)
    elif isinstance(snap.get("quotes"), list):
        raw_items = snap["quotes"]

    quotes_map: Dict[str, Dict[str, Any]] = {}
    need_trend_codes: List[str] = []
    for raw in raw_items:
        code_key = str(raw.get("code") or raw.get("symbol") or "").strip().upper()
        norm = _normalize_relay_quote_item(raw, meta_by_code.get(code_key))
        if not norm:
            continue
        c = norm["code"]
        quotes_map[c] = norm
        if (norm.get("swing_trend", {}).get("level") == "unknown") or (norm.get("scalp_trend", {}).get("level") == "unknown"):
            need_trend_codes.append(c)

    if quotes_map:
        with _cache_lock:
            for c, q in quotes_map.items():
                _quote_cache[c] = q

    if need_trend_codes:
        _schedule_trend_backfill(need_trend_codes)

    return {"fx": fx_data, "quotes": quotes_map}


def _fetch_relay_snapshot(conf: Optional[Dict[str, Any]] = None, timeout: float = 4.0) -> tuple:
    """Fetch full FX + quotes snapshot from personal relay server. Returns (merged_dict, error_str)."""
    if conf is None:
        conf = load_stock_config()
    data, err = _relay_http_json_request("GET", "/api/snapshot", conf=conf, timeout=timeout)
    if err or not isinstance(data, dict):
        return None, err or "잘못된 릴레이 응답입니다."
    return _merge_relay_snapshot_payload(data, conf), None


def _reset_active_ws() -> None:
    global _active_ws
    with _stream_lock:
        ws = _active_ws
        _active_ws = None
    if ws:
        try:
            ws.close()
        except Exception:
            pass
    _wake_event.set()


def update_ws_subscriptions() -> bool:
    """Dynamically sends updated trade subscriptions (KR & US) to active WebSocket."""
    global _active_ws
    conf = load_stock_config()
    if _is_relay_mode(conf):
        _sync_relay_watchlist_background(conf)
        with _stream_lock:
            ws = _active_ws
            paused = _is_paused
        if ws:
            try:
                ws.send(json.dumps({"type": "subscribe", "watchlist": _build_relay_watchlist_payload(conf)}))
                return True
            except Exception:
                pass
        elif not paused:
            resume_streaming()
        return False

    sub_list = _build_ws_subscription_payload(conf)

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


def _run_relay_ws_iteration(conf: Dict[str, Any]) -> None:
    """Single WebSocket session (or REST polling fallback) against personal relay server."""
    global _backoff_delay, _active_ws, _consecutive_ws_failures

    try:
        import websocket
        has_ws = True
    except ImportError:
        has_ws = False

    if not has_ws:
        merged, err = _fetch_relay_snapshot(conf, timeout=4.0)
        if merged:
            for q in merged.get("quotes", {}).values():
                tick = dict(q)
                tick["silent"] = True
                broadcast_tick_update(tick)
        elif err and not _is_paused and not _stop_streaming_event.is_set():
            logger.log_warn("StockService", f"Relay snapshot polling notice: {err}")
        _wake_event.clear()
        if not _is_paused and not _stop_streaming_event.is_set():
            _wake_event.wait(timeout=3.0)
        return

    ws_url = _relay_ws_url(conf.get("relay_url", ""), conf.get("relay_token", ""))
    if not ws_url:
        _wake_event.clear()
        _wake_event.wait(timeout=3.0)
        return

    relay_token = str(conf.get("relay_token") or "").strip()
    headers = [f"Authorization: Bearer {relay_token}"] if relay_token else []
    conn_state = {
        "opened": False,
        "auth_error": False,
        "ping_stop": threading.Event()
    }

    def _on_relay_reconnect_sync():
        try:
            _sync_relay_watchlist(conf, timeout=3.0)
            merged, _ = _fetch_relay_snapshot(conf, timeout=4.0)
            if merged:
                for q in merged.get("quotes", {}).values():
                    tick = dict(q)
                    tick["silent"] = True
                    broadcast_tick_update(tick)
        except Exception as e:
            logger.log_debug("StockService", f"Relay reconnect sync notice: {e}")

    try:
        def on_message(ws, msg):
            try:
                if isinstance(msg, bytes):
                    msg = msg.decode("utf-8", errors="replace")
                text = (msg or "").strip()
                if not text or text.upper() == "PONG":
                    return

                data = json.loads(text)
                if not isinstance(data, dict):
                    return
                msg_type = str(data.get("type") or "").lower()

                if msg_type in ("pong", "ping", "heartbeat"):
                    return

                if msg_type == "error":
                    err_code = str(data.get("code") or "")
                    err_msg = str(data.get("message") or data.get("error") or "")
                    if err_code in ("unauthorized", "auth-failed", "401", "403"):
                        conn_state["auth_error"] = True
                        try:
                            ws.close()
                        except Exception:
                            pass
                    logger.log_warn("StockService", f"Relay WS error [{err_code}]: {err_msg}")
                    return

                if msg_type == "snapshot":
                    merged = _merge_relay_snapshot_payload(data, conf)
                    for q in merged.get("quotes", {}).values():
                        tick = dict(q)
                        tick["silent"] = True
                        broadcast_tick_update(tick)
                    return

                if msg_type == "fx" and isinstance(data.get("fx"), dict):
                    with _cache_lock:
                        _fx_cache["data"] = data["fx"]
                        _fx_cache["expires_at"] = time.time() + 60.0
                    return

                raw_tick = data.get("data") if isinstance(data.get("data"), dict) and "code" not in data else data
                if isinstance(raw_tick, dict) and (raw_tick.get("code") or raw_tick.get("symbol")):
                    code = str(raw_tick.get("code") or raw_tick.get("symbol")).strip().upper()
                    with _cache_lock:
                        prev = dict(_quote_cache.get(code, {}))
                    norm = _normalize_relay_quote_item(raw_tick, prev)
                    if norm:
                        p_val = float(norm.get("price", 0.0) or 0.0)
                        prev_p = float(prev.get("price", 0.0) or 0.0) if prev.get("price") is not None else p_val
                        if "prev_price" in raw_tick:
                            norm["prev_price"] = float(raw_tick["prev_price"])
                        elif prev_p > 0:
                            norm["prev_price"] = prev_p
                        if "tick_diff" in raw_tick:
                            norm["tick_diff"] = float(raw_tick["tick_diff"])
                        elif prev_p > 0:
                            norm["tick_diff"] = round(p_val - prev_p, 4)
                        if raw_tick.get("silent") or data.get("silent"):
                            norm["silent"] = True
                        broadcast_tick_update(norm)
            except Exception as ex:
                logger.log_warn("StockService", f"Relay WS message parse error: {ex}")

        def on_open(ws):
            global _backoff_delay, _active_ws, _consecutive_ws_failures
            conn_state["opened"] = True
            _backoff_delay = 1.0
            _consecutive_ws_failures = 0
            with _stream_lock:
                _active_ws = ws
            threading.Thread(
                target=_ws_ping_worker,
                args=(ws, conn_state["ping_stop"]),
                name="StockRelayPingThread",
                daemon=True
            ).start()
            threading.Thread(
                target=_on_relay_reconnect_sync,
                name="StockRelayReconnectSyncThread",
                daemon=True
            ).start()

        def on_close(ws, status=None, msg=None):
            global _active_ws
            conn_state["ping_stop"].set()
            with _stream_lock:
                if _active_ws is ws:
                    _active_ws = None
            msg_str = str(msg or "")
            if status in (401, 403) or "401" in msg_str or "403" in msg_str:
                conn_state["auth_error"] = True
            if not _is_paused and not _stop_streaming_event.is_set():
                logger.log_info("StockService", f"Relay WebSocket closed: status={status}, msg={msg}")

        def on_error(ws, err):
            global _active_ws
            with _stream_lock:
                if _active_ws is ws:
                    _active_ws = None
            err_str = str(err or "")
            if any(k in err_str.lower() for k in ("401", "403", "unauthorized", "forbidden")):
                conn_state["auth_error"] = True
            if not _is_paused and not _stop_streaming_event.is_set():
                logger.log_warn("StockService", f"Relay WebSocket error: {err_str}")

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
            logger.log_warn("StockService", f"Relay WebSocket connection failed: {e}")
    finally:
        conn_state["ping_stop"].set()
        with _stream_lock:
            _active_ws = None

    if _stop_streaming_event.is_set() or _is_paused:
        return

    if conn_state["auth_error"]:
        _backoff_delay = max(_backoff_delay, 10.0)

    if not conn_state["opened"]:
        _consecutive_ws_failures += 1

    wait_sec = _backoff_delay + random.uniform(0.0, 0.5)
    _wake_event.clear()
    if not _is_paused and not _stop_streaming_event.is_set():
        _wake_event.wait(timeout=wait_sec)
    _backoff_delay = min(30.0, _backoff_delay * 2.0)


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

            conf = load_stock_config()
            if _is_relay_mode(conf):
                _run_relay_ws_iteration(conf)
                continue

            token = get_valid_token(min_ttl=120.0)
            if not token:
                _wake_event.clear()
                _wake_event.wait(timeout=3.0)
                continue

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

def _build_dashboard_payload(conf: Dict[str, Any], force_refresh: bool = False) -> Dict[str, Any]:
    watchlist = conf.get("watchlist", DEFAULT_WATCHLIST)
    relay_mode = _is_relay_mode(conf)
    relay_err: Optional[str] = None

    if relay_mode:
        api_configured = True
        merged, relay_err = _fetch_relay_snapshot(conf, timeout=4.0)
        _sync_relay_watchlist_background(conf)
        if merged:
            fx_data = merged.get("fx") or fetch_exchange_rates(force_refresh=force_refresh)
            quotes_map = merged.get("quotes") or {}
        else:
            fx_data = fetch_exchange_rates(force_refresh=force_refresh)
            with _cache_lock:
                quotes_map = {k: dict(v) for k, v in _quote_cache.items()}
    else:
        cid = conf.get("client_id", "").strip()
        csec = conf.get("client_secret", "").strip()
        api_configured = bool(cid and csec)
        fx_data = fetch_exchange_rates(force_refresh=force_refresh)
        quotes_map = fetch_initial_prices(watchlist, force_refresh=force_refresh)

    items = []
    missing_trend_codes = []
    for w in watchlist:
        code = w.get("code")
        if code in quotes_map:
            q_item = dict(quotes_map[code])
            attach_trends_to_quote(code, q_item)
            items.append(q_item)
        else:
            q_item = {
                "code": code,
                "name": w.get("name", code),
                "market": w.get("market", "KR"),
                "price": 0.0,
                "change": 0.0,
                "change_rate": 0.0,
                "session": "CLOSE",
                "currency": "KRW" if w.get("market") == "KR" else "USD",
                "formatted_price": "--"
            }
            attach_trends_to_quote(code, q_item)
            items.append(q_item)
            if code:
                missing_trend_codes.append(code)

    if relay_mode and missing_trend_codes:
        _schedule_trend_backfill(missing_trend_codes)

    res: Dict[str, Any] = {
        "status": "success",
        "api_configured": api_configured,
        "connection_mode": "relay" if relay_mode else "local",
        "relay_url": conf.get("relay_url", "") if relay_mode else "",
        "fx": fx_data,
        "watchlist": items,
        "groups": conf.get("groups", []),
        "active_group_id": conf.get("active_group_id", "g_default")
    }
    if relay_err:
        res["relay_error"] = relay_err
    return res


@eel.expose
def get_stock_dashboard_data() -> Dict[str, Any]:
    """Returns FX rates, watchlist quotes, and API/relay configuration flag."""
    conf = load_stock_config()
    return _build_dashboard_payload(conf, force_refresh=False)


@eel.expose
def get_stock_connection_config() -> Dict[str, Any]:
    """Returns current stock connection configuration (local Toss API vs personal relay server)."""
    conf = load_stock_config()
    return {
        "connection_mode": conf.get("connection_mode", "local"),
        "client_id": conf.get("client_id", ""),
        "client_secret": conf.get("client_secret", ""),
        "relay_url": conf.get("relay_url", ""),
        "relay_token": conf.get("relay_token", "")
    }


@eel.expose
def save_stock_connection_config(
    mode: str = "local",
    client_id: str = "",
    client_secret: str = "",
    relay_url: str = "",
    relay_token: str = ""
) -> Dict[str, Any]:
    """Saves local Toss API or personal relay server connection settings and validates them."""
    clean_mode = "relay" if str(mode or "").strip().lower() == "relay" else "local"
    cid = (client_id or "").strip()
    csec = (client_secret or "").strip()
    r_url = _normalize_relay_url(relay_url)
    r_tok = (relay_token or "").strip()

    conf = load_stock_config()
    conf["client_id"] = cid
    conf["client_secret"] = csec
    conf["relay_url"] = r_url
    conf["relay_token"] = r_tok

    if clean_mode == "relay":
        if not r_url:
            return {"success": False, "error": "릴레이 서버 URL을 입력해주세요. (예: https://relay.example.com)"}

        test_conf = dict(conf)
        test_conf["connection_mode"] = "relay"
        merged, err = _fetch_relay_snapshot(test_conf, timeout=4.0)
        if err and "404" in err:
            health_data, health_err = _relay_http_json_request("GET", "/api/health", conf=test_conf, timeout=4.0)
            if health_data is not None and not health_err:
                merged, err = {"fx": None, "quotes": {}}, None

        if err:
            return {"success": False, "error": f"릴레이 서버 연결 실패: {err}"}

        conf["connection_mode"] = "relay"
        save_stock_config(conf)
        _sync_relay_watchlist_background(conf)
        _reset_active_ws()
        resume_streaming()
        return {
            "success": True,
            "message": "개인 릴레이 서버 연결에 성공하였습니다.",
            "configured": True,
            "connection_mode": "relay"
        }

    conf["connection_mode"] = "local"
    save_stock_config(conf)
    invalidate_access_token(reason="connection config updated")
    _reset_active_ws()

    if not cid or not csec:
        return {
            "success": True,
            "message": "로컬 직접 모드로 저장되었습니다. (API 키 미등록)",
            "configured": False,
            "connection_mode": "local"
        }

    token = _fetch_access_token(cid, csec)
    if token:
        sync_master_stocks_background()
        resume_streaming()
        return {
            "success": True,
            "message": "Toss Open API 인증에 성공하였습니다.",
            "configured": True,
            "connection_mode": "local"
        }
    return {
        "success": False,
        "error": "인증에 실패하였습니다. Client ID/Secret 및 허용 공인 IP를 확인해주세요."
    }


@eel.expose
def save_stock_api_keys(client_id: str, client_secret: str) -> Dict[str, Any]:
    """Legacy wrapper: saves local Toss API credentials and switches to local mode."""
    conf = load_stock_config()
    return save_stock_connection_config(
        mode="local",
        client_id=client_id,
        client_secret=client_secret,
        relay_url=conf.get("relay_url", ""),
        relay_token=conf.get("relay_token", "")
    )


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

    if _is_relay_mode(conf):
        _sync_relay_watchlist(conf, timeout=2.5)
        merged, _ = _fetch_relay_snapshot(conf, timeout=2.5)
        quote_data = (merged.get("quotes") or {}).get(clean_code) if merged else None
        if not quote_data:
            quote_data = dict(new_item)
            attach_trends_to_quote(clean_code, quote_data)
            _schedule_trend_backfill([clean_code])
    else:
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
    return _build_dashboard_payload(conf, force_refresh=True)