"""
tests/test_stock_websocket_failsafe.py
Unit tests for Toss WebSocket subscription payload, keepalive PING, auth-revoked recovery,
pause/resume/stop lifecycle, and REST polling fallback behavior.
"""
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

import services.stock_service as stock_service


class FakeWebSocketApp:
    instances = []

    def __init__(self, url, header=None, on_open=None, on_message=None, on_error=None, on_close=None):
        self.url = url
        self.header = header
        self.on_open = on_open
        self.on_message = on_message
        self.on_error = on_error
        self.on_close = on_close
        self.sent = []
        self.closed = False
        self._close_event = threading.Event()
        FakeWebSocketApp.instances.append(self)

    def send(self, data):
        self.sent.append(data)

    def close(self):
        self.closed = True
        self._close_event.set()

    def run_forever(self, **kwargs):
        if self.on_open:
            self.on_open(self)
        self._close_event.wait(timeout=2.0)
        if self.on_close:
            self.on_close(self, 1000, "closed")


class TestStockWebSocketFailSafe(unittest.TestCase):
    def setUp(self):
        FakeWebSocketApp.instances.clear()
        stock_service.stop_streaming()
        time.sleep(0.05)
        stock_service.invalidate_access_token()
        stock_service._stop_streaming_event.clear()
        stock_service._wake_event.clear()
        stock_service._is_paused = False
        stock_service._is_streaming_active = False
        stock_service._ws_thread = None
        stock_service._active_ws = None
        stock_service._backoff_delay = 1.0
        stock_service._consecutive_ws_failures = 0

    def tearDown(self):
        stock_service.stop_streaming()
        time.sleep(0.05)

    def test_subscription_payload_uses_market_map_and_100_limit(self):
        conf = {
            "watchlist": [
                {"code": "005930", "name": "삼성전자", "market": "KR"},
                {"code": "0101N0", "name": "테스트KR", "market": "KR"},
                {"code": "AAPL", "name": "Apple", "market": "US"},
            ],
            "groups": [
                {"id": "g_default", "name": "기본", "codes": ["005930", "0101N0", "AAPL", "NVDA"]}
            ],
        }
        payload = stock_service._build_ws_subscription_payload(conf)
        by_type = {p["type"]: p["codes"] for p in payload}
        self.assertEqual(by_type["trade:kr"], ["005930", "0101N0"])
        self.assertEqual(by_type["trade:us"], ["AAPL", "NVDA"])

        # Verify 100-topic cap
        many_codes = [f"SYM{i:03d}" for i in range(120)]
        big_conf = {"watchlist": [], "groups": [{"id": "g1", "name": "big", "codes": many_codes}]}
        big_payload = stock_service._build_ws_subscription_payload(big_conf)
        total_codes = sum(len(p["codes"]) for p in big_payload)
        self.assertEqual(total_codes, 100)

    def test_auth_revoked_invalidates_token_and_reconnects(self):
        sample_conf = {
            "client_id": "cid",
            "client_secret": "csec",
            "watchlist": [{"code": "AAPL", "name": "Apple", "market": "US"}],
            "groups": [{"id": "g1", "name": "기본", "codes": ["AAPL"]}],
        }
        tokens = iter(["tok-1", "tok-2"])

        def fake_get_token(min_ttl=0.0):
            return next(tokens, "tok-2")

        fake_ws_mod = mock.MagicMock()
        fake_ws_mod.WebSocketApp = FakeWebSocketApp

        with mock.patch.object(stock_service, "load_stock_config", return_value=sample_conf), \
             mock.patch.object(stock_service, "get_valid_token", side_effect=fake_get_token) as m_tok, \
             mock.patch.object(stock_service, "_resync_quotes_on_reconnect"), \
             mock.patch.dict(sys.modules, {"websocket": fake_ws_mod}):
            stock_service.resume_streaming()

            # Wait for first connection
            deadline = time.time() + 2.0
            while len(FakeWebSocketApp.instances) < 1 and time.time() < deadline:
                time.sleep(0.02)
            self.assertGreaterEqual(len(FakeWebSocketApp.instances), 1)
            ws1 = FakeWebSocketApp.instances[0]
            self.assertEqual(ws1.header, ["Authorization: Bearer tok-1"])

            # Wait for subscription send
            deadline = time.time() + 1.0
            while not ws1.sent and time.time() < deadline:
                time.sleep(0.02)
            self.assertTrue(ws1.sent)
            self.assertEqual(json.loads(ws1.sent[0]), [{"type": "trade:us", "codes": ["AAPL"]}])

            # Simulate auth-revoked error frame
            ws1.on_message(ws1, json.dumps({
                "type": "error",
                "error": {"code": "auth-revoked", "message": "token expired"}
            }))
            self.assertTrue(ws1.closed)

            # Wait for reconnect with tok-2
            deadline = time.time() + 3.0
            while len(FakeWebSocketApp.instances) < 2 and time.time() < deadline:
                time.sleep(0.05)
            self.assertGreaterEqual(len(FakeWebSocketApp.instances), 2)
            ws2 = FakeWebSocketApp.instances[1]
            self.assertEqual(ws2.header, ["Authorization: Bearer tok-2"])
            self.assertGreaterEqual(m_tok.call_count, 2)

    def test_pause_closes_socket_and_resume_wakes_immediately(self):
        sample_conf = {
            "client_id": "cid",
            "client_secret": "csec",
            "watchlist": [{"code": "005930", "name": "삼성전자", "market": "KR"}],
            "groups": [{"id": "g1", "name": "기본", "codes": ["005930"]}],
        }
        fake_ws_mod = mock.MagicMock()
        fake_ws_mod.WebSocketApp = FakeWebSocketApp

        with mock.patch.object(stock_service, "load_stock_config", return_value=sample_conf), \
             mock.patch.object(stock_service, "get_valid_token", return_value="tok-1"), \
             mock.patch.object(stock_service, "_resync_quotes_on_reconnect"), \
             mock.patch.dict(sys.modules, {"websocket": fake_ws_mod}):
            stock_service.resume_streaming()
            deadline = time.time() + 2.0
            while len(FakeWebSocketApp.instances) < 1 and time.time() < deadline:
                time.sleep(0.02)
            ws1 = FakeWebSocketApp.instances[0]

            # Wait until _active_ws is registered
            deadline = time.time() + 1.0
            while stock_service._active_ws is None and time.time() < deadline:
                time.sleep(0.01)

            stock_service.pause_streaming()
            self.assertTrue(ws1.closed)
            self.assertTrue(stock_service._is_paused)

            stock_service.resume_streaming()
            deadline = time.time() + 1.5
            while len(FakeWebSocketApp.instances) < 2 and time.time() < deadline:
                time.sleep(0.02)
            self.assertGreaterEqual(len(FakeWebSocketApp.instances), 2)

    def test_ping_worker_sends_plain_text_ping(self):
        ws = FakeWebSocketApp("wss://example")
        stop_ev = threading.Event()
        with mock.patch.object(stop_ev, "wait", side_effect=[False, True]):
            stock_service._ws_ping_worker(ws, stop_ev)
        self.assertEqual(ws.sent, ["PING"])

    def test_polling_fallback_does_not_escalate_backoff(self):
        sample_conf = {
            "client_id": "cid",
            "client_secret": "csec",
            "watchlist": [{"code": "005930", "name": "삼성전자", "market": "KR"}],
            "groups": [{"id": "g1", "name": "기본", "codes": ["005930"]}],
        }
        real_import = __import__

        def fake_import(name, *args, **kwargs):
            if name == "websocket":
                raise ImportError("no websocket")
            return real_import(name, *args, **kwargs)

        with mock.patch.object(stock_service, "load_stock_config", return_value=sample_conf), \
             mock.patch.object(stock_service, "get_valid_token", return_value="tok-1"), \
             mock.patch.object(stock_service, "fetch_initial_prices", return_value={"005930": {"code": "005930", "price": 72000}}) as m_fetch, \
             mock.patch.object(stock_service, "broadcast_tick_update"), \
             mock.patch.object(stock_service._wake_event, "wait", side_effect=lambda timeout=None: stock_service._stop_streaming_event.set()), \
             mock.patch("builtins.__import__", side_effect=fake_import):
            stock_service._streaming_worker()
            self.assertEqual(m_fetch.call_count, 1)
            self.assertEqual(stock_service._backoff_delay, 1.0)


if __name__ == "__main__":
    unittest.main()
