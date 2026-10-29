"""Test local protocols for five database families, read-only boundaries, and error propagation
without business databases.
"""
import builtins
from contextlib import contextmanager, closing
import importlib.util
import json
from pathlib import Path
import socket
import socketserver
import sqlite3
import ssl
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.services import connector_database as db
from app.services import connector_database_extra as extra


def spec(kind, **env):
    return {"name": "fixture", "command": "soduwork-connector", "args": [kind], "env": env}


def result(spec_, name, args=None):
    data = json.loads(db.execute(spec_, "call", name, args))
    return json.loads(data["content"][0]["text"])


def health(spec_, timeout=3):
    return json.loads(db.execute(spec_, "health", timeout=timeout))


@contextmanager
def redis_server(auth_error=False, ping=b"+PONG\r\n", value=b"hello"):
    commands = []
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            while True:
                line = self.rfile.readline(8192)
                if not line:
                    return
                count = int(line[1:-2])
                parts = []
                for _ in range(count):
                    size = int(self.rfile.readline(8192)[1:-2])
                    parts.append(self.rfile.read(size))
                    self.rfile.read(2)
                commands.append(parts)
                op = parts[0].upper()
                if op == b"AUTH":
                    reply = b"-WRONGPASS private-password-private-user\r\n" if auth_error else b"+OK\r\n"
                elif op == b"PING":
                    reply = ping
                elif op == b"SCAN":
                    reply = b"*2\r\n$1\r\n7\r\n*3\r\n$1\r\na\r\n$1\r\nb\r\n$1\r\nc\r\n"
                elif op == b"TYPE":
                    reply = b"+string\r\n"
                elif op == b"GETRANGE":
                    reply = b"$" + str(len(value)).encode() + b"\r\n" + value + b"\r\n"
                elif op == b"SELECT":
                    reply = b"+OK\r\n"
                else:
                    reply = b"-ERR unsupported fixture command\r\n"
                self.wfile.write(reply)
                self.wfile.flush()
    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True
    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1], commands
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


@contextmanager
def http_server(responder, context=None):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *_):
            pass
        def do_GET(self):
            self.process()
        def do_POST(self):
            self.process()
        def process(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            requests.append((self.command, self.path, dict(self.headers), body))
            code, headers, payload = responder(requests[-1])
            data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(code)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    if context:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield ("https" if context else "http") + "://127.0.0.1:" + str(server.server_port), requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


class DatabaseExtraTests(unittest.TestCase):
    def test_dispatch_and_bundled_definitions_no_env_override(self):
        for kind in ("postgres", "mysql", "sqlite", "redis", "mongodb", "clickhouse", "elasticsearch"):
            self.assertTrue(db.handles(spec(kind)))
            self.assertEqual(db.definition(kind)["id"], kind)
        self.assertFalse(db.handles(spec("os")))
        self.assertFalse(db.handles({"command": "soduwork-connector", "args": ["redis", "extra"]}))
        with self.assertRaises(ValueError):
            db.config(spec("redis", REDIS_HOST="localhost", SODUWORK_CONNECTORS_DIR="other"))

    def test_sqlite_read_columns_schema_binary_and_readonly_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "中文 数据.db"
            with closing(sqlite3.connect(path)) as conn, conn:
                conn.execute("CREATE TABLE reports (identifier INTEGER PRIMARY KEY, title TEXT, payload BLOB)")
                conn.execute("INSERT INTO reports VALUES (1, '测试', x'ff01')")
            before = path.read_bytes()
            target = spec("sqlite", SQLITE_PATH=str(path))
            self.assertEqual(health(target)["connectionState"], "verified")
            self.assertEqual(result(target, "list_tables")["rows"], [["reports"]])
            rows = result(target, "read_rows", {"table": "reports"})
            self.assertEqual(rows["columns"], ["identifier", "title", "payload"])
            self.assertEqual(rows["rows"][0][:2], [1, "测试"])
            self.assertEqual(rows["rows"][0][2], {"encoding": "base64", "value": "/wE="})
            self.assertEqual(result(target, "describe_table", {"table": "reports"})["rows"][1][0], "title")
            with extra._sqlite_connection({"SQLITE_PATH": str(path)}, 2) as conn:
                with self.assertRaises(sqlite3.OperationalError):
                    conn.execute("DELETE FROM reports")
            self.assertEqual(path.read_bytes(), before)

    def test_sqlite_empty_columns_missing_invalid_and_injection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.db"
            with closing(sqlite3.connect(path)) as conn, conn:
                conn.execute("CREATE TABLE sample (identifier INTEGER)")
                conn.execute("CREATE VIEW view_sample AS SELECT * FROM sample")
            target = spec("sqlite", SQLITE_PATH=str(path))
            self.assertEqual(result(target, "read_rows", {"table": "sample"})["columns"], ["identifier"])
            for args in ({"table": 'sample"; DROP TABLE sample;--'}, {"table": "view_sample"}, {"table": "sample", "limit": True}, {"table": "sample", "sql": "DELETE"}):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    result(target, "read_rows", args)
            missing = Path(directory) / "missing.db"
            self.assertFalse(health(spec("sqlite", SQLITE_PATH=str(missing)))["ok"])
            self.assertFalse(missing.exists())
            path.write_text("not a database", encoding="utf-8")
            self.assertFalse(health(target)["ok"])

    def test_sqlite_large_cell_is_rejected_without_returning_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.db"
            with closing(sqlite3.connect(path)) as conn, conn:
                conn.execute("CREATE TABLE sample (payload BLOB)")
                conn.execute("INSERT INTO sample VALUES (zeroblob(?))", (extra.MAX_BYTES,))
            with self.assertRaises(ValueError):
                result(spec("sqlite", SQLITE_PATH=str(path)), "read_rows", {"table": "sample"})

    def test_redis_real_driver_ping_auth_scan_page_and_bounded_value(self):
        with redis_server(value=b"\xff\x01") as (port, commands):
            target = spec("redis", REDIS_HOST="127.0.0.1", REDIS_PORT=str(port), REDIS_TLS="false", REDIS_USER="reader", REDIS_PASSWORD="secret")
            self.assertEqual(health(target)["connectionState"], "verified")
            page = result(target, "scan_keys", {"count": 1, "cursor": "2", "match": "a*"})
            self.assertEqual(page["keys"], ["a", "b", "c"])
            self.assertEqual(page["next_cursor"], "7")
            self.assertEqual(result(target, "get_value", {"key": "a"})["value"], "/wE=")
            self.assertIn([b"AUTH", b"reader", b"secret"], commands)
            self.assertIn([b"GETRANGE", b"a", b"0", str(extra.MAX_VALUE_BYTES).encode()], commands)
            self.assertFalse(any(c[0] in {b"SET", b"GET", b"KEYS", b"EVAL"} for c in commands))

    def test_redis_failure_never_reports_success_or_driver_details(self):
        with redis_server(auth_error=True) as (port, _):
            target = spec("redis", REDIS_HOST="127.0.0.1", REDIS_PORT=str(port), REDIS_TLS="false", REDIS_PASSWORD="secret")
            data = health(target)
            self.assertEqual(data["connectionState"], "needs_auth")
            self.assertFalse(data["authenticationTested"])
            self.assertNotIn("private", json.dumps(data))
            with self.assertRaisesRegex(ValueError, "授权失败"):
                result(target, "ping")
        with redis_server(ping=b"+NOTPONG\r\n") as (port, _):
            self.assertFalse(health(spec("redis", REDIS_HOST="127.0.0.1", REDIS_PORT=str(port), REDIS_TLS="false"))["ok"])

    def test_redis_oversize_and_tls_options(self):
        with redis_server(value=b"x" * (extra.MAX_VALUE_BYTES + 1)) as (port, _):
            with self.assertRaisesRegex(ValueError, "1 MiB"):
                result(spec("redis", REDIS_HOST="127.0.0.1", REDIS_PORT=str(port), REDIS_TLS="false"), "get_value", {"key": "large"})
        with self.assertRaisesRegex(ValueError, "TLS"):
            db.config(spec("redis", REDIS_HOST="redis.example.com", REDIS_TLS="false"))
        _, values = db.config(spec("redis", REDIS_HOST="redis.example.com"))
        with patch("redis.Redis") as constructor:
            extra._redis_connection(values, 3)
        self.assertTrue(constructor.call_args.kwargs["ssl_check_hostname"])
        self.assertEqual(constructor.call_args.kwargs["ssl_cert_reqs"], "required")

    def test_clickhouse_real_http_health_is_authorized_query_and_list_no_table(self):
        def reply(request):
            sql = request[3].decode()
            if "SELECT 1" in sql:
                return 200, {}, {"data": [{"connected": 1}]}
            return 200, {}, {"meta": [{"name": "name"}], "data": [{"name": "events"}]}
        with http_server(reply) as (url, requests):
            target = spec("clickhouse", CH_URL=url, CH_DATABASE="default", CH_USER="reader", CH_PASSWORD="secret")
            self.assertEqual(health(target)["connectionState"], "verified")
            self.assertEqual(result(target, "list_tables")["rows"], [{"name": "events"}])
            self.assertIn("system.tables", requests[-1][3].decode())
            for method, path, headers, body in requests:
                self.assertEqual(method, "POST")
                self.assertNotIn("/ping", path)
                self.assertTrue(headers["Authorization"].startswith("Basic "))
                self.assertEqual(parse_qs(urlsplit(path).query)["readonly"], ["1"])
                self.assertEqual(parse_qs(urlsplit(path).query)["result_overflow_mode"], ["throw"])

    def test_http_auth_errors_redirect_and_oversize_are_safe(self):
        for status, headers, payload, expected in [(403, {}, b"private-secret", "needs_auth"),
                (500, {"X-ClickHouse-Exception-Code": "516"}, b"private-secret", "needs_auth"),
                (302, {"Location": "https://other.invalid"}, b"", "error"),
                (200, {}, b"x" * (extra.MAX_BYTES + 1), "error")]:
            with self.subTest(status=status, expected=expected), http_server(lambda _:(status, headers, payload)) as (url, requests):
                data = health(spec("clickhouse", CH_URL=url, CH_DATABASE="default", CH_PASSWORD="secret"))
                self.assertEqual(data["connectionState"], expected)
                self.assertNotIn("private", json.dumps(data))
                self.assertEqual(len(requests), 1)

    def test_elasticsearch_identity_and_fixed_search_pagination(self):
        def reply(request):
            if request[1] == "/_security/_authenticate":
                return 200, {}, {"username": "private-reader"}
            return 200, {}, {"hits": {"total": {"value": 1}, "hits": [{"_id": "1", "_source": {"name": "fixture"}}]}, "_shards": {"failed": 0}}
        with http_server(reply) as (url, requests):
            target = spec("elasticsearch", ES_URL=url, ES_API_KEY="private-key")
            data = health(target)
            self.assertEqual(data["connectionState"], "verified")
            self.assertNotIn("private", json.dumps(data))
            output = result(target, "search_documents", {"index": "events", "from": 9900, "size": 100})
            self.assertEqual(output["documents"][0]["_id"], "1")
            body = json.loads(requests[-1][3])
            self.assertEqual(body["query"], {"match_all": {}})
            for args in ({"index": "events", "from": 9999, "size": 2}, {"index": "../other"}, {"index": "events", "query": {"script": "x"}}):
                with self.assertRaises(ValueError):
                    result(target, "search_documents", args)
            self.assertEqual(len(requests), 2)

    def test_es_partial_error_and_missing_document(self):
        with http_server(lambda _: (200, {}, {"timed_out": True, "hits": {"hits": []}})) as (url, _):
            with self.assertRaisesRegex(ValueError, "超时"):
                result(spec("elasticsearch", ES_URL=url), "search_documents", {"index": "events"})
        with http_server(lambda _: (404, {}, {"found": False})) as (url, _):
            self.assertFalse(result(spec("elasticsearch", ES_URL=url), "get_document", {"index": "events", "id": "missing"})["found"])
        with http_server(lambda _: (404, {}, {"error": "index_not_found_exception"})) as (url, _):
            with self.assertRaises(ValueError):
                result(spec("elasticsearch", ES_URL=url), "get_document", {"index": "events", "id": "missing"})

    def test_configuration_rejects_unsafe_endpoints_and_mixed_auth(self):
        for url in ("http://remote.example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=x"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                db.config(spec("elasticsearch", ES_URL=url))
        with self.assertRaises(ValueError):
            db.config(spec("elasticsearch", ES_URL="https://example.com", ES_API_KEY="key", ES_USERNAME="user"))
        with self.assertRaises(ValueError):
            db.config(spec("mongodb", MONGO_HOST="localhost", MONGO_DATABASE="test", MONGO_USER="reader"))

    def test_missing_driver_is_clear_and_health_not_verified(self):
        original = builtins.__import__
        def missing(name, *args, **kwargs):
            if name == "redis" or name.startswith("redis."):
                raise ImportError("missing redis private-directory")
            return original(name, *args, **kwargs)
        target = spec("redis", REDIS_HOST="127.0.0.1", REDIS_TLS="false")
        with patch("builtins.__import__", side_effect=missing):
            self.assertFalse(health(target)["ok"])
            with self.assertRaisesRegex(ValueError, "缺少数据库驱动") as raised:
                result(target, "ping")
            self.assertNotIn("private", str(raised.exception))

    def test_mongo_filter_no_code_and_finite_numbers(self):
        for condition in ({"$where": "private"}, {"nested": {"$function": "private"}}, {"x": float("nan")}, {"x": {"$regex": "(x+)+"}}):
            with self.subTest(condition=condition), self.assertRaises(ValueError):
                extra._filter(condition)
        extra._filter({"$and": [{"age": {"$gte": 18}}, {"kind": {"$in": ["a", "b"]}}]})


    def test_transport_timeout_and_offline_are_not_verified(self):
        class Slow(socketserver.StreamRequestHandler):
            def handle(self):
                self.rfile.readline(8192)
                time.sleep(1.3)
        class Server(socketserver.ThreadingTCPServer):
            daemon_threads = True
        with Server(("127.0.0.1", 0), Slow) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                target = spec("redis", REDIS_HOST="127.0.0.1", REDIS_PORT=str(server.server_address[1]), REDIS_TLS="false")
                started = time.monotonic()
                data = health(target, timeout=1)
                self.assertFalse(data["ok"])
                self.assertEqual(data["connectionState"], "error")
                self.assertLess(time.monotonic() - started, 2.0)
            finally:
                server.shutdown()
                thread.join(2)
        with socket.socket() as unused:
            unused.bind(("127.0.0.1", 0))
            port = unused.getsockname()[1]
        self.assertFalse(health(spec("redis", REDIS_HOST="127.0.0.1", REDIS_PORT=str(port), REDIS_TLS="false"), timeout=1)["ok"])

    def test_redis_no_permission_is_auth_failure(self):
        from redis.exceptions import NoPermissionError
        with patch.object(extra, "_redis", side_effect=NoPermissionError("private-account")):
            data = health(spec("redis", REDIS_HOST="localhost"))
        self.assertEqual(data["connectionState"], "needs_auth")
        self.assertNotIn("private", json.dumps(data))


if __name__ == "__main__":
    unittest.main()
