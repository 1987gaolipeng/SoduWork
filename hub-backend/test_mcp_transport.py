"""Real loopback peers: no database, production identity or business tools."""
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from app.services import mcp_http


class Peer(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def reply(self, status, value=None, **headers):
        body = json.dumps(value).encode() if value is not None else b""
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/json")
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_DELETE(self):
        self.server.seen.append(("DELETE", {}, dict(self.headers)))
        if self.server.mode == "broken-delete":
            self.wfile.write(b"invalid-fixture-secret-status\r\n\r\n")
            self.wfile.flush()
            self.close_connection = True
            return
        self.reply(204)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = request.get("method")
        self.server.seen.append((method, request, dict(self.headers)))
        if method in (None, "notifications/initialized"):
            return self.reply(503 if self.server.mode == "notify-fails" else 202)
        if method == "initialize":
            return self.reply(200, {
                "jsonrpc": "2.0", "id": True if self.server.mode == "boolean-id" else request["id"], "result": {
                    "protocolVersion": self.server.version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "isolated-peer", "version": "1"},
                }}, **({} if self.server.mode == "sessionless" else
                       {"MCP-Session-Id": "fixture-session"}))
        if self.server.mode == "expire" and not self.server.expired:
            self.server.expired = True
            return self.reply(404)
        if self.server.mode == "redirect":
            return self.reply(307, None, Location=self.server.url + "/other")
        if self.server.mode == "broken-chunk":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.write(b"invalid-fixture-secret-chunk\r\n")
            self.wfile.flush()
            self.close_connection = True
            return
        if self.server.mode == "expire-always":
            return self.reply(404)
        if self.server.mode == "accepted":
            return self.reply(202)
        if self.server.mode == "error-secret":
            return self.reply(200, {"jsonrpc": "2.0", "id": request["id"],
                "error": {"code": -32603, "message": "fixture-secret-value"}})
        if self.server.mode == "oversize":
            return self.reply(200, {"jsonrpc": "2.0", "id": request["id"],
                "result": {"data": "x" * 2_000_000}})
        if self.server.mode == "expire-page":
            if request.get("params", {}).get("cursor") and not self.server.expired:
                self.server.expired = True
                return self.reply(404)
            result = {"tools": [{"name": "new_tool" if self.server.expired else "old_tool"}]}
            if not self.server.expired:
                result["nextCursor"] = " cursor "
            return self.reply(200, {"jsonrpc": "2.0", "id": request["id"], "result": result})
        if method == "tools/list":
            result = {"tools": [{"name": "read_status", "inputSchema": {"type": "object"}}]}
            if self.server.mode == "cycle":
                result["nextCursor"] = "same-cursor"
        else:
            result = {"content": [{"type": "text", "text": ("中文结果🙂" if self.server.mode == "sse-fragments" else "BUSINESS_OK")}]}
        reply = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        if self.server.mode == "malformed":
            reply["result"] = []
        if self.server.mode == "boolean-id":
            reply["id"] = True
        if self.server.mode.startswith("sse-"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                if self.server.mode == "sse-heartbeat":
                    while not self.server.release.wait(0.05):
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                else:
                    note = b'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n'
                    raw = json.dumps(reply, ensure_ascii=False).encode()
                    if self.server.mode == "sse-fragments":
                        # Multiline JSON event, CRLF split over writes and UTF-8 split over bytes.
                        raw = raw.replace(b', "result"', b',\r\ndata: "result"', 1)
                        raw = note + b"data:\r\n\r\ndata: " + raw + b"\r\n\r\n"
                        for byte in raw:
                            self.wfile.write(bytes([byte]))
                            self.wfile.flush()
                    elif self.server.mode == "sse-cr":
                        self.wfile.write(b"data: " + raw + b"\r\r")
                        self.wfile.flush()
                        self.server.release.wait(4)
                    else:
                        self.wfile.write(b"data: " + raw + b"\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True
            return
        if self.server.mode == "sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write((": keepalive\n\ndata: " + json.dumps(reply) + "\n\n").encode())
            self.wfile.flush()
            self.server.release.wait(4)
            self.close_connection = True
            return
        if self.server.mode == "wrong-id":
            reply["id"] += 100
        if self.server.mode == "request-not-response":
            reply = {"jsonrpc": "2.0", "id": request["id"], "method": "sampling/createMessage"}
        self.reply(200, reply)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.peer = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
        self.peer.daemon_threads = True
        self.peer.seen, self.peer.mode = [], "normal"
        self.peer.version, self.peer.expired = "2025-11-25", False
        self.peer.release = threading.Event()
        self.peer.url = "http://127.0.0.1:" + str(self.peer.server_port)
        self.thread = threading.Thread(target=self.peer.serve_forever, daemon=True)
        self.thread.start()
        self.spec = {"url": self.peer.url + "/mcp",
                     "headers": {"Authorization": "Bearer fixture-only"}}

    def tearDown(self):
        self.peer.release.set()
        self.peer.shutdown()
        self.peer.server_close()
        self.thread.join(2)

    def methods(self):
        return [item[0] for item in self.peer.seen]

    def test_stream_result_returns_without_waiting_for_eof(self):
        self.peer.mode = "sse"
        start = time.monotonic()
        try:
            self.assertEqual(mcp_http.call(self.spec, "read_status", timeout=3), "BUSINESS_OK")
            self.assertLess(time.monotonic() - start, 1.5)
        finally:
            self.peer.release.set()

    def test_negotiation_rejects_unknown_version(self):
        self.peer.version = "9999-01-01"
        with self.assertRaisesRegex(ValueError, "版本"):
            mcp_http.list_tools(self.spec)
        self.assertNotIn("tools/list", self.methods())

    def test_paginated_catalog_never_silently_succeeds_on_cycle(self):
        self.peer.mode = "cycle"
        with self.assertRaisesRegex(ValueError, "分页"):
            mcp_http.list_tools(self.spec)

    def test_read_can_reinitialize_expired_session_once(self):
        self.peer.mode = "expire"
        self.assertEqual(mcp_http.list_tools(self.spec)[0]["name"], "read_status")
        self.assertEqual(self.methods().count("initialize"), 2)

    def test_tool_call_is_never_automatically_replayed(self):
        self.peer.mode = "expire"
        with self.assertRaisesRegex(ValueError, "重新|重试|过期"):
            mcp_http.call(self.spec, "write_status", {})
        self.assertEqual(self.methods().count("tools/call"), 1)

    def test_redirect_is_not_followed(self):
        self.peer.mode = "redirect"
        with self.assertRaisesRegex(ValueError, "重定向"):
            mcp_http.list_tools(self.spec)
        self.assertEqual(self.methods().count("tools/list"), 1)

    def test_request_with_colliding_id_is_not_a_result(self):
        self.peer.mode = "request-not-response"
        with self.assertRaises(ValueError):
            mcp_http.list_tools(self.spec)

    def test_wrong_id_is_not_accepted(self):
        self.peer.mode = "wrong-id"
        with self.assertRaises(ValueError):
            mcp_http.call(self.spec, "read_status")

    def test_close_resets_state_for_reuse(self):
        session = mcp_http.HttpSession(self.spec).initialize()
        session.close()
        self.assertFalse(session.initialized)
        session.call("tools/list")
        session.close()
        self.assertEqual(self.methods().count("initialize"), 2)

    def test_failed_initialized_notification_clears_state(self):
        self.peer.mode = "notify-fails"
        session = mcp_http.HttpSession(self.spec)
        with self.assertRaises(ValueError):
            session.initialize()
        self.assertFalse(session.initialized)
        self.assertEqual(session.session_id, "")
        self.peer.mode = "normal"
        session.call("tools/list")
        session.close()
        self.assertEqual(self.methods().count("initialize"), 2)

    def test_sessionless_close_also_requires_new_handshake(self):
        self.peer.mode = "sessionless"
        session = mcp_http.HttpSession(self.spec).initialize()
        session.close()
        self.assertFalse(session.initialized)
        session.call("tools/list")
        session.close()
        self.assertEqual(self.methods().count("initialize"), 2)

    def test_expired_cursor_restarts_entire_catalog_without_mixing_versions(self):
        self.peer.mode = "expire-page"
        self.assertEqual([t["name"] for t in mcp_http.list_tools(self.spec)], ["new_tool"])
        self.assertEqual(self.methods().count("initialize"), 2)

    def test_repeated_expiration_stops_after_one_reinitialization(self):
        self.peer.mode = "expire-always"
        with self.assertRaisesRegex(ValueError, "过期"):
            mcp_http.list_tools(self.spec)
        self.assertEqual(self.methods().count("initialize"), 2)
        self.assertEqual(self.methods().count("tools/list"), 2)

    def test_fragmented_sse_preserves_unicode_and_skips_notifications(self):
        self.peer.mode = "sse-fragments"
        self.assertEqual(mcp_http.call(self.spec, "read_status"), "中文结果🙂")

    def test_truncated_sse_is_not_treated_as_a_completed_result(self):
        self.peer.mode = "sse-truncated"
        with self.assertRaisesRegex(ValueError, "完整"):
            mcp_http.call(self.spec, "read_status")

    def test_heartbeats_do_not_extend_the_absolute_deadline(self):
        self.peer.mode = "sse-heartbeat"
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(ValueError, "超时"):
                mcp_http.call(self.spec, "read_status", timeout=3)
            self.assertLess(time.monotonic() - started, 4.5)
            self.assertEqual(self.methods().count("tools/call"), 1)
        finally:
            self.peer.release.set()

    def test_accepted_without_result_is_not_success_or_replayed(self):
        self.peer.mode = "accepted"
        with self.assertRaisesRegex(ValueError, "受理"):
            mcp_http.call(self.spec, "write_status")
        self.assertEqual(self.methods().count("tools/call"), 1)

    def test_protocol_error_does_not_echo_remote_credential_text(self):
        self.peer.mode = "error-secret"
        with self.assertRaises(ValueError) as caught:
            mcp_http.call(self.spec, "read_status")
        self.assertNotIn("fixture-secret-value", str(caught.exception))
        self.assertIn("-32603", str(caught.exception))

    def test_oversized_json_response_is_rejected(self):
        self.peer.mode = "oversize"
        with self.assertRaisesRegex(ValueError, "上限"):
            mcp_http.call(self.spec, "read_status")

    def test_invalid_result_shape_is_not_empty_success(self):
        self.peer.mode = "malformed"
        with self.assertRaisesRegex(ValueError, "对象"):
            mcp_http.call(self.spec, "read_status")

    def test_boolean_response_id_cannot_match_integer_request(self):
        self.peer.mode = "boolean-id"
        with self.assertRaisesRegex(ValueError, "ID"):
            mcp_http.call(self.spec, "read_status")

    def test_transport_headers_cannot_be_overridden_by_stale_configuration(self):
        spec = {**self.spec, "headers": {**self.spec["headers"],
            "mcp-session-id": "stale-session", "MCP-protocol-VERSION": "9999-01-01"}}
        mcp_http.list_tools(spec)
        initial = {k.lower(): v for k, v in self.peer.seen[0][2].items()}
        self.assertNotIn("mcp-session-id", initial)
        discovery = next(headers for method, _, headers in self.peer.seen if method == "tools/list")
        discovery = {k.lower(): v for k, v in discovery.items()}
        self.assertEqual(discovery["mcp-session-id"], "fixture-session")
        self.assertEqual(discovery["mcp-protocol-version"], "2025-11-25")

    def test_broken_chunk_fails_without_echoing_response_bytes(self):
        self.peer.mode = "broken-chunk"
        with self.assertRaisesRegex(ValueError, "中断") as caught:
            mcp_http.call(self.spec, "read_status")
        self.assertNotIn("fixture-secret", str(caught.exception))
        self.assertEqual(self.methods().count("tools/call"), 1)

    def test_invalid_header_fails_before_network_without_echoing_credentials(self):
        spec = {**self.spec, "headers": {"Authorization": "Bearer fixture-secret\nvalue"}}
        with self.assertRaisesRegex(ValueError, "请求头") as caught:
            mcp_http.list_tools(spec)
        self.assertNotIn("fixture-secret", str(caught.exception))
        self.assertEqual(self.methods(), [])


    def test_cr_only_stream_result_returns_before_eof(self):
        self.peer.mode = "sse-cr"
        started = time.monotonic()
        self.assertEqual(mcp_http.call(self.spec, "read_status", timeout=3), "BUSINESS_OK")
        self.assertLess(time.monotonic() - started, 1.5)

    def test_malformed_delete_cannot_replace_a_successful_result(self):
        self.peer.mode = "broken-delete"
        session = mcp_http.HttpSession(self.spec)
        with session:
            self.assertEqual(session.call("tools/call", {"name": "read_status"})["content"][0]["text"], "BUSINESS_OK")
        self.assertFalse(session.initialized)
        self.assertEqual(session.session_id, "")
        self.assertEqual(self.methods().count("tools/call"), 1)

if __name__ == "__main__":
    unittest.main()
