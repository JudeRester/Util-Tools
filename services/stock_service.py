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

# Streaming State
_is_streaming_active: bool = False
_is_paused: bool = False
_ws_thread: Optional[threading.Thread] = None
_stop_streaming_event = threading.Event()
_backoff_delay: float = 1.0

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
                return json.load(f)
        except Exception as e:
            logger.log_warn("StockService", f"Failed to read stock config: {e}")
            return {
                "client_id": "",
                "client_secret": "",
                "watchlist": DEFAULT_WATCHLIST,
                "fx_cache": {}
            }


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

    # 1. Try Toss Open API if token is active
    token = get_valid_token()
    toss_success = False
    if token:
        try:
            req = urllib.request.Request(
                "https://openapi.tossinvest.com/api/v1/exchange-rate",
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "UtilTools-EdgeWidget/1.0"
                }
            )
            with urllib.request.urlopen(req, timeout=3.0, context=_SSL_CTX) as resp:
                tdata = json.loads(resp.read().decode("utf-8"))
                rates = tdata.get("rates", tdata.get("data", []))
                if isinstance(rates, list):
                    for r in rates:
                        cur = r.get("currency") or r.get("symbol")
                        rate_val = float(r.get("rate") or r.get("price", 0))
                        chg_val = float(r.get("change", 0))
                        if cur == "USD":
                            usd_krw = rate_val
                            usd_change = chg_val
                            toss_success = True
                        elif cur in ("JPY", "JPY100"):
                            jpy_krw = rate_val
                            jpy_change = chg_val
        except Exception as e:
            logger.log_debug("StockService", f"Toss FX fetch bypass/error: {e}")

    # 2. Public Fallback API for USD & JPY
    if not toss_success:
        endpoints = [
            "https://open.er-api.com/v6/latest/USD",
            "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"
        ]
        for ep in endpoints:
            try:
                req = urllib.request.Request(ep, headers={"User-Agent": "curl/7.68.0"})
                with urllib.request.urlopen(req, timeout=2.5, context=_SSL_CTX) as resp:
                    pdata = json.loads(resp.read().decode("utf-8"))
                    rates_map = pdata.get("rates") or pdata.get("usd", {})
                    krw_rate = float(rates_map.get("KRW") or rates_map.get("krw", 0))
                    jpy_rate = float(rates_map.get("JPY") or rates_map.get("jpy", 0))
                    if krw_rate > 0:
                        usd_krw = round(krw_rate, 2)
                        if jpy_rate > 0:
                            jpy_krw = round((krw_rate / jpy_rate) * 100, 2)
                        break
            except Exception:
                continue

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


def fetch_initial_prices(symbols: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Fetch initial/fallback REST quotes for symbols."""
    token = get_valid_token()
    results = {}

    for sym in symbols:
        code = sym.get("code", "")
        name = sym.get("name", code)
        market = sym.get("market", "KR")

        if code in _quote_cache:
            results[code] = _quote_cache[code]
            continue

        base_price = 72000.0 if market == "KR" else 210.0
        quote = {
            "code": code,
            "name": name,
            "market": market,
            "price": base_price,
            "change": 0.0,
            "change_rate": 0.0,
            "session": "REG",
            "currency": "KRW" if market == "KR" else "USD",
            "formatted_price": f"{int(base_price):,}원" if market == "KR" else f"${base_price:,.2f}"
        }

        if token:
            try:
                url = f"https://openapi.tossinvest.com/api/v1/prices?symbol={urllib.parse.quote(code)}"
                req = urllib.request.Request(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "User-Agent": "UtilTools-EdgeWidget/1.0"
                    }
                )
                with urllib.request.urlopen(req, timeout=2.0, context=_SSL_CTX) as resp:
                    pdata = json.loads(resp.read().decode("utf-8"))
                    item = pdata.get("data", pdata)
                    p_val = float(item.get("price", base_price))
                    c_val = float(item.get("change", 0.0))
                    cr_val = float(item.get("change_rate", 0.0))
                    session = parse_session_status(item.get("session", "REGULAR"))
                    quote.update({
                        "price": p_val,
                        "change": c_val,
                        "change_rate": cr_val,
                        "session": session,
                        "formatted_price": f"{int(p_val):,}원" if market == "KR" else f"${p_val:,.2f}"
                    })
            except Exception as e:
                logger.log_debug("StockService", f"Price REST quote error for {code}: {e}")

        _quote_cache[code] = quote
        results[code] = quote

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
        symbols = [s.get("code") for s in conf.get("watchlist", []) if s.get("code")]
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
                        code = data.get("symbol") or data.get("code")
                        if code:
                            p_val = float(data.get("price", 0.0))
                            c_val = float(data.get("change", 0.0))
                            cr_val = float(data.get("change_rate", 0.0))
                            sess = parse_session_status(data.get("session", "REG"))
                            mkt = data.get("market", "KR" if code.isdigit() else "US")
                            tick = {
                                "code": code,
                                "price": p_val,
                                "change": c_val,
                                "change_rate": cr_val,
                                "session": sess,
                                "formatted_price": f"{int(p_val):,}원" if mkt == "KR" else f"${p_val:,.2f}"
                            }
                            broadcast_tick_update(tick)
                    except Exception as ex:
                        logger.log_debug("StockService", f"WS tick parse error: {ex}")

                def on_open(ws):
                    global _backoff_delay
                    _backoff_delay = 1.0
                    sub_msg = json.dumps({"action": "subscribe", "symbols": symbols})
                    ws.send(sub_msg)
                    logger.log_info("StockService", f"Subscribed to stock symbols: {symbols}")

                def on_error(ws, err):
                    logger.log_debug("StockService", f"WebSocket error: {err}")

                ws_app = websocket.WebSocketApp(
                    ws_url,
                    header=headers,
                    on_open=on_open,
                    on_message=on_message,
                    on_error=on_error
                )
                ws_app.run_forever(sslopt={"cert_reqs": ssl.CERT_NONE}, ping_interval=20, ping_timeout=10)
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
        "watchlist": items
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
def add_stock_symbol(code: str, name: str, market: str) -> Dict[str, Any]:
    """Adds a new stock symbol to watchlist and fetches initial price."""
    clean_code = (code or "").strip().upper()
    clean_name = (name or clean_code).strip()
    clean_market = (market or ("KR" if clean_code.isdigit() else "US")).strip().upper()

    if not clean_code:
        return {"success": False, "error": "종목 코드가 유효하지 않습니다."}

    conf = load_stock_config()
    watchlist = conf.get("watchlist", [])

    if any(item.get("code") == clean_code for item in watchlist):
        return {"success": False, "error": "이미 관심 종목에 등록되어 있습니다."}

    new_item = {"code": clean_code, "name": clean_name, "market": clean_market}
    watchlist.append(new_item)
    conf["watchlist"] = watchlist
    save_stock_config(conf)

    quotes = fetch_initial_prices([new_item])
    quote_data = quotes.get(clean_code, new_item)

    return {"success": True, "item": quote_data}


@eel.expose
def remove_stock_symbol(code: str) -> Dict[str, Any]:
    """Removes a stock symbol from watchlist."""
    clean_code = (code or "").strip().upper()
    conf = load_stock_config()
    watchlist = conf.get("watchlist", [])
    filtered = [item for item in watchlist if item.get("code") != clean_code]

    if len(filtered) == len(watchlist):
        return {"success": False, "error": "해당 종목을 찾을 수 없습니다."}

    conf["watchlist"] = filtered
    save_stock_config(conf)
    with _cache_lock:
        _quote_cache.pop(clean_code, None)

    return {"success": True, "code": clean_code}


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
