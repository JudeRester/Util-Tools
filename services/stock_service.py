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

_access_token: Optional[str] = None
_token_expires_at: float = 0.0

_fx_cache: Dict[str, Any] = {"data": None, "expires_at": 0.0}
_quote_cache: Dict[str, Dict[str, Any]] = {}
_master_cache: List[Dict[str, Any]] = []
_prev_close_cache: Dict[str, Dict[str, Any]] = {}
_market_calendar_cache: Dict[str, Dict[str, Any]] = {}

# Streaming State
_is_streaming_active: bool = False
_is_paused: bool = False
_ws_thread: Optional[threading.Thread] = None
_stop_streaming_event = threading.Event()
_backoff_delay: float = 1.0
_active_ws: Any = None
_last_broadcast_time: Dict[str, float] = {}

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
# Toss Open API OAuth2 Authentication
# -----------------------------------------------------------------------------

def _fetch_access_token(client_id: str, client_secret: str) -> Optional[str]:
    global _access_token, _token_expires_at
    if not client_id or not client_secret:
        return None

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

    try:
        with urllib.request.urlopen(req, timeout=5.0, context=_SSL_CTX) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            token = data.get("access_token")
            expires_in = int(data.get("expires_in", 3600))
            if token:
                _access_token = token
                _token_expires_at = time.time() + max(60, expires_in - 60)
                logger.log_info("StockService", "Toss Open API OAuth2 access token issued successfully")
                return token
    except Exception as e:
        logger.log_warn("StockService", f"Failed to obtain Toss OAuth token: {e}")
    return None


def get_valid_token() -> Optional[str]:
    global _access_token, _token_expires_at
    if _access_token and time.time() < _token_expires_at:
        return _access_token

    conf = load_stock_config()
    cid = conf.get("client_id", "")
    csec = conf.get("client_secret", "")
    if cid and csec:
        return _fetch_access_token(cid, csec)
    return None


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
    token = get_valid_token()
    toss_success = False
    if token:
        try:
            req = urllib.request.Request(
                "https://openapi.tossinvest.com/api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW",
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "UtilTools-EdgeWidget/1.0"
                }
            )
            with urllib.request.urlopen(req, timeout=3.0, context=_SSL_CTX) as resp:
                tdata = json.loads(resp.read().decode("utf-8"))
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
        _fx_cache = {"data": result, "expires_at": now + 60.0}

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
            time.sleep(1.1)
            url = f"https://openapi.tossinvest.com/api/v1/stocks/all?market={m}"
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "UtilTools-EdgeWidget/1.0"
                }
            )
            try:
                with urllib.request.urlopen(req, timeout=5.0, context=_SSL_CTX) as r:
                    d = json.loads(r.read().decode('utf-8'))
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
    """Fetch previous business day regular market end time cut for candle querying."""
    now = time.time()
    with _cache_lock:
        cached = _market_calendar_cache.get(market)
        if cached and now < cached.get("expires_at", 0.0):
            return cached.get("cut_time")

    if not token:
        token = get_valid_token()
    if not token:
        return None

    try:
        url = f"https://openapi.tossinvest.com/api/v1/market-calendar/{market}"
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": "UtilTools-EdgeWidget/1.0"
            }
        )
        with urllib.request.urlopen(req, timeout=3.0, context=_SSL_CTX) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            prev_biz = data.get("result", {}).get("previousBusinessDay", {})
            cut_time = None
            if market == "KR":
                end_t = prev_biz.get("integrated", {}).get("regularMarket", {}).get("endTime")
                if end_t:
                    # Closing auction candle matches at 15:30:xx, recorded as 15:31:00 in 1m candles
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
                        "expires_at": now + 1800.0  # 30 minutes TTL
                    }
                return cut_time
    except Exception as e:
        logger.log_debug("StockService", f"Market calendar fetch notice for {market}: {e}")

    return None


def fetch_prev_close(symbol: str, token: Optional[str] = None) -> Optional[float]:
    """
    Fetch previous regular session close price (전일 정규장 종가 기준).
    Uses Toss Open API 1m candle at previous regular close cut time,
    with Naver Finance fallback for KR stocks and 1d daily candle fallback.
    """
    if not symbol:
        return None

    now = time.time()
    with _cache_lock:
        cached = _prev_close_cache.get(symbol)
        if cached and now < cached.get("expires_at", 0.0):
            return cached.get("price")

    if not token:
        token = get_valid_token()

    is_kr = symbol.isdigit() or symbol.endswith(".KS") or symbol.endswith(".KQ")
    market = "KR" if is_kr else "US"
    prev_close = None

    # Method 1: Query Toss 1m candle before regular session close cut
    if token:
        cut_time = fetch_regular_market_close_cut(market, token)
        if cut_time:
            try:
                url = (
                    f"https://openapi.tossinvest.com/api/v1/candles"
                    f"?symbol={urllib.parse.quote(symbol)}&interval=1m&before={urllib.parse.quote(cut_time)}&count=1"
                )
                req = urllib.request.Request(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "User-Agent": "UtilTools-EdgeWidget/1.0"
                    }
                )
                with urllib.request.urlopen(req, timeout=3.0, context=_SSL_CTX) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    candles = data.get("result", {}).get("candles", [])
                    if candles and candles[0].get("closePrice") is not None:
                        prev_close = float(candles[0].get("closePrice"))
            except Exception as e:
                logger.log_debug("StockService", f"1m regular close candle fetch failed for {symbol}: {e}")

    # Method 2: Fallback for KR stocks via Naver Finance mobile basic API
    if prev_close is None and is_kr:
        try:
            clean_sym = symbol.replace(".KS", "").replace(".KQ", "")
            url = f"https://m.stock.naver.com/api/stock/{clean_sym}/basic"
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0"}
            )
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                ndata = json.loads(resp.read().decode("utf-8"))
                cur_str = ndata.get("closePrice", "0").replace(",", "")
                diff_str = ndata.get("compareToPreviousClosePrice", "0").replace(",", "")
                cur_p = float(cur_str)
                diff_p = float(diff_str)
                if cur_p > 0:
                    prev_close = cur_p - diff_p
        except Exception as e:
            logger.log_debug("StockService", f"Naver prev close fallback failed for {symbol}: {e}")

    # Method 3: Fallback via 1d daily candles (last trade price of previous day)
    if prev_close is None and token:
        try:
            url = f"https://openapi.tossinvest.com/api/v1/candles?symbol={urllib.parse.quote(symbol)}&interval=1d"
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "UtilTools-EdgeWidget/1.0"
                }
            )
            with urllib.request.urlopen(req, timeout=3.0, context=_SSL_CTX) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                candles = data.get("result", {}).get("candles", [])
                if len(candles) >= 2:
                    c_val = candles[1].get("closePrice")
                    if c_val is not None:
                        prev_close = float(c_val)
                elif len(candles) == 1:
                    o_val = candles[0].get("openPrice")
                    if o_val is not None:
                        prev_close = float(o_val)
        except Exception as e:
            logger.log_warn("StockService", f"Failed to fetch prev close for {symbol}: {e}")

    if prev_close is not None:
        with _cache_lock:
            _prev_close_cache[symbol] = {
                "price": prev_close,
                "expires_at": now + 300.0
            }
        return prev_close

    return None


def fetch_initial_prices(symbols: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Fetch initial quotes using batch GET /api/v1/prices?symbols=..."""
    token = get_valid_token()
    results = {}
    code_list = [s.get("code") for s in symbols if s.get("code")]

    # 1. Base skeleton
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

    # 2. Batch fetch live prices from Toss
    if token and code_list:
        try:
            symbols_param = urllib.parse.quote(",".join(code_list))
            url = f"https://openapi.tossinvest.com/api/v1/prices?symbols={symbols_param}"
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "UtilTools-EdgeWidget/1.0"
                }
            )
            with urllib.request.urlopen(req, timeout=3.0, context=_SSL_CTX) as resp:
                pdata = json.loads(resp.read().decode("utf-8"))
                items = pdata.get("result", [])
                for it in items:
                    c = it.get("symbol")
                    if c in results:
                        p_val = float(it.get("lastPrice", results[c]["price"]))
                        curr = it.get("currency", results[c]["currency"])
                        results[c]["price"] = p_val
                        results[c]["currency"] = curr
                        results[c]["formatted_price"] = f"{int(p_val):,}원" if curr == "KRW" else f"${p_val:,.2f}"
        except Exception as e:
            logger.log_warn("StockService", f"Batch prices fetch notice: {e}")

    # Concurrently fetch previous regular session close for all symbols
    prev_closes = {}
    if token and code_list:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(5, len(code_list) or 1)) as executor:
            future_to_code = {executor.submit(fetch_prev_close, c, token): c for c in code_list}
            for future in concurrent.futures.as_completed(future_to_code):
                c = future_to_code[future]
                try:
                    res = future.result()
                    if res is not None:
                        prev_closes[c] = res
                except Exception as ex:
                    logger.log_warn("StockService", f"Error fetching prev close for {c}: {ex}")

    for c in code_list:
        if c not in results:
            continue
        p_val = results[c]["price"]
        prev_close = prev_closes.get(c)
        if prev_close is None:
            with _cache_lock:
                cached = _prev_close_cache.get(c)
                if cached:
                    prev_close = cached.get("price")
        base_p = prev_close or p_val
        results[c]["base_price"] = base_p
        is_us = results[c]["currency"] == "USD" or not c.isdigit()
        c_val = round(p_val - base_p, 2 if is_us else 0)
        cr_val = round((c_val / base_p * 100), 2) if base_p else 0.0
        results[c]["change"] = c_val
        results[c]["change_rate"] = cr_val

    for c, q in results.items():
        _quote_cache[c] = q

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

    now = time.time()
    if now - _last_broadcast_time.get(code, 0.0) < 0.1:
        with _cache_lock:
            if code in _quote_cache:
                _quote_cache[code].update(tick_data)
            else:
                _quote_cache[code] = tick_data
        return
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


def update_ws_subscriptions() -> bool:
    """Dynamically sends updated trade subscriptions (KR & US) to active WebSocket."""
    global _active_ws
    conf = load_stock_config()
    all_codes = set()
    for g in conf.get("groups", []):
        for c in g.get("codes", []):
            if c:
                all_codes.add(str(c).strip().upper())
    for w in conf.get("watchlist", []):
        if w.get("code"):
            all_codes.add(str(w.get("code")).strip().upper())
    symbols = sorted(list(all_codes))
    kr_codes = [s for s in symbols if s.isdigit()]
    us_codes = [s for s in symbols if not s.isdigit()]
    sub_list = []
    if us_codes:
        sub_list.append({"type": "trade:us", "codes": us_codes})
    if kr_codes:
        sub_list.append({"type": "trade:kr", "codes": kr_codes})

    if _active_ws:
        try:
            _active_ws.send(json.dumps(sub_list))
            logger.log_info("StockService", f"Dynamic subscription updated: {sub_list}")
            return True
        except Exception as e:
            logger.log_warn("StockService", f"Failed to send dynamic subscription: {e}")
            _active_ws = None
            resume_streaming()
            return False
    else:
        resume_streaming()
        return False


def _streaming_worker():
    global _is_streaming_active, _backoff_delay
    logger.log_info("StockService", "Stock streaming background thread started")

    while not _stop_streaming_event.is_set():
        if _is_paused:
            time.sleep(0.5)
            continue

        token = get_valid_token()
        if not token:
            time.sleep(2.0)
            continue

        conf = load_stock_config()
        all_codes = set()
        for g in conf.get("groups", []):
            for c in g.get("codes", []):
                if c:
                    all_codes.add(str(c).strip().upper())
        for w in conf.get("watchlist", []):
            if w.get("code"):
                all_codes.add(str(w.get("code")).strip().upper())
        symbols = sorted(list(all_codes))
        if not symbols:
            time.sleep(2.0)
            continue

        try:
            import websocket
            has_ws = True
        except ImportError:
            has_ws = False

        if has_ws:
            try:
                ws_url = "wss://openapi-ws.tossinvest.com/ws/v1"
                headers = [f"Authorization: Bearer {token}"]

                def on_message(ws, msg):
                    try:
                        data = json.loads(msg)
                        if data.get("type") == "message":
                            topic = data.get("topic", "")
                            code = topic.split(":")[-1]
                            trade = data.get("data", {})
                            if code and trade:
                                p_val = float(trade.get("price", 0.0))
                                curr = trade.get("currency", "USD" if not code.isdigit() else "KRW")
                                mkt = "KR" if curr == "KRW" or code.isdigit() else "US"

                                prev = _quote_cache.get(code, {})
                                base_p = float(prev.get("base_price", 0.0))
                                if base_p <= 0:
                                    base_p = float(_prev_close_cache.get(code, {}).get("price", p_val))
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
                    global _backoff_delay, _active_ws
                    _backoff_delay = 1.0
                    _active_ws = ws
                    update_ws_subscriptions()

                def on_close(ws, status=None, msg=None):
                    global _active_ws
                    _active_ws = None
                    logger.log_info("StockService", f"WebSocket closed: status={status}, msg={msg}")

                def on_error(ws, err):
                    global _active_ws
                    _active_ws = None
                    logger.log_warn("StockService", f"WebSocket error: {err}")

                ws_app = websocket.WebSocketApp(
                    ws_url,
                    header=headers,
                    on_open=on_open,
                    on_message=on_message,
                    on_error=on_error,
                    on_close=on_close
                )
                ws_app.run_forever(sslopt={"cert_reqs": ssl.CERT_NONE}, ping_interval=20, ping_timeout=10)
                _active_ws = None
            except Exception as e:
                logger.log_debug("StockService", f"WebSocket connection failed: {e}")
        else:
            try:
                quotes = fetch_initial_prices(conf.get("watchlist", []))
                for q in quotes.values():
                    broadcast_tick_update(q)
            except Exception:
                pass
            time.sleep(5.0)

        if not _stop_streaming_event.is_set():
            time.sleep(_backoff_delay)
            _backoff_delay = min(30.0, _backoff_delay * 2.0)

    _is_streaming_active = False


def pause_streaming() -> None:
    global _is_paused
    _is_paused = True
    logger.log_info("StockService", "Stock streaming paused (widget collapsed)")


def resume_streaming() -> None:
    global _is_paused, _is_streaming_active, _ws_thread
    _is_paused = False
    logger.log_info("StockService", "Stock streaming resumed (widget expanded)")
    if not _is_streaming_active or _ws_thread is None or not _ws_thread.is_alive():
        _stop_streaming_event.clear()
        _ws_thread = threading.Thread(target=_streaming_worker, name="StockStreamingThread", daemon=True)
        _is_streaming_active = True
        _ws_thread.start()


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
        token = get_valid_token()
        if token:
            try:
                url = f"https://openapi.tossinvest.com/api/v1/stocks?symbols={urllib.parse.quote(query.strip().upper())}"
                req = urllib.request.Request(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "User-Agent": "UtilTools-EdgeWidget/1.0"
                    }
                )
                with urllib.request.urlopen(req, timeout=2.0, context=_SSL_CTX) as r:
                    d = json.loads(r.read().decode('utf-8'))
                    items = d.get('result', d.get('data', []))
                    if isinstance(items, list) and items:
                        it = items[0]
                        results.append({
                            'code': it.get('symbol', query.strip().upper()),
                            'name': it.get('name', query.strip().upper()),
                            'market': it.get('market', 'KR' if query.isdigit() else 'US')
                        })
            except Exception as e:
                logger.log_debug("StockService", f"Direct stock lookup error: {e}")

    return results


@eel.expose
def refresh_stock_data() -> Dict[str, Any]:
    """Forces immediate FX and price quotes refresh."""
    fetch_exchange_rates(force_refresh=True)
    conf = load_stock_config()
    with _cache_lock:
        _quote_cache.clear()
    fetch_initial_prices(conf.get("watchlist", []))
    return get_stock_dashboard_data()