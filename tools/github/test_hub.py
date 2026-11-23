from __future__ import annotations

import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import subprocess
import threading
import unittest
from unittest.mock import Mock, patch
import urllib.request

import hub


class FakeClock:
    def __init__(self, oversleep=0):
        self.now = 100.0
        self.oversleep = oversleep
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        if seconds <= 0:
            raise AssertionError("Retry sleep must advance time")
        self.sleeps.append(seconds)
        self.now += seconds + self.oversleep


class HubWaitTests(unittest.TestCase):
    def test_transient_probe_errors_retry_until_success(self):
        errors = [
            http.client.IncompleteRead(b'{"ready":', 5),
            http.client.BadStatusLine("invalid status"),
            http.client.RemoteDisconnected("startup connection closed"),
            OSError("connection unavailable"),
            ValueError("Hub is not ready"),
            subprocess.CalledProcessError(1, ["docker", "exec", "db", "pg_isready"]),
        ]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                clock = FakeClock()
                ready = object()
                probe = Mock(side_effect=[error, ready])
                with patch.object(hub, "time", clock):
                    self.assertIs(hub.wait(probe, seconds=5), ready)
                self.assertEqual(probe.call_count, 2)
                self.assertEqual(clock.sleeps, [2])

    def test_success_preserves_the_probe_return_value_without_sleep(self):
        for result in (None, False, "ready"):
            with self.subTest(result=result):
                clock = FakeClock()
                probe = Mock(return_value=result)
                with patch.object(hub, "time", clock):
                    self.assertIs(hub.wait(probe, seconds=5), result)
                probe.assert_called_once_with()
                self.assertEqual(clock.sleeps, [])

    def test_programming_error_and_interrupt_propagate_without_retry(self):
        for error in (TypeError("invalid readiness callback"), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                clock = FakeClock()
                probe = Mock(side_effect=error)
                with patch.object(hub, "time", clock), self.assertRaises(type(error)) as caught:
                    hub.wait(probe, seconds=5)
                self.assertIs(caught.exception, error)
                probe.assert_called_once_with()
                self.assertEqual(clock.sleeps, [])

    def test_last_error_is_preserved_when_probe_consumes_deadline(self):
        clock = FakeClock()
        first = OSError("previous connection failure")
        last = http.client.IncompleteRead(b'{"ready":', 5)

        def probe():
            if clock.now == 100:
                raise first
            clock.now += 3
            raise last

        check = Mock(side_effect=probe)
        with patch.object(hub, "time", clock), self.assertRaises(type(last)) as caught:
            hub.wait(check, seconds=5)
        self.assertIs(caught.exception, last)
        self.assertEqual(check.call_count, 2)
        self.assertEqual(clock.sleeps, [2])
        self.assertEqual(clock.now, 105)

    def test_last_error_is_preserved_when_sleep_crosses_deadline(self):
        clock = FakeClock(oversleep=0.25)
        first = OSError("previous connection failure")
        last = ValueError("last readiness failure")
        probe = Mock(side_effect=[first, last])
        with patch.object(hub, "time", clock), self.assertRaises(type(last)) as caught:
            hub.wait(probe, seconds=3)
        self.assertIs(caught.exception, last)
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(clock.sleeps, [2, 0.75])
        self.assertEqual(clock.now, 103.25)

    def test_sleep_is_bounded_by_remaining_budget(self):
        clock = FakeClock()
        error = OSError("still starting")
        probe = Mock(side_effect=error)
        with patch.object(hub, "time", clock), self.assertRaises(type(error)) as caught:
            hub.wait(probe, seconds=0.25)
        self.assertIs(caught.exception, error)
        probe.assert_called_once_with()
        self.assertEqual(clock.sleeps, [0.25])
        self.assertEqual(clock.now, 100.25)

    def test_nonpositive_budget_does_not_start_a_probe(self):
        for seconds in (0, -1):
            with self.subTest(seconds=seconds):
                clock = FakeClock()
                probe = Mock()
                with patch.object(hub, "time", clock), self.assertRaisesRegex(
                        TimeoutError, "Isolated Hub acceptance timed out"):
                    hub.wait(probe, seconds=seconds)
                probe.assert_not_called()
                self.assertEqual(clock.sleeps, [])

    def test_truncated_http_read_retries_until_ready_json_arrives(self):
        requests = []

        class ReadinessHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                body = b'{"ready":' if len(requests) == 1 else b'{"ready": true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body) + (5 if len(requests) == 1 else 0)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

            def log_message(self, format, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), ReadinessHandler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        origin = "http://127.0.0.1:" + str(server.server_port)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        clock = FakeClock()

        def ready():
            with opener.open(origin + "/readyz", timeout=2) as response:
                payload = json.loads(response.read())
            hub.require(payload.get("ready") is True, "Hub is not ready")
            return payload

        try:
            with patch.object(hub, "time", clock):
                self.assertEqual(hub.wait(ready, seconds=5), {"ready": True})
            self.assertEqual(requests, ["/readyz", "/readyz"])
            self.assertEqual(clock.sleeps, [2])
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertFalse(thread.is_alive(), "Readiness fixture must stop its HTTP thread")


if __name__ == "__main__":
    unittest.main()
