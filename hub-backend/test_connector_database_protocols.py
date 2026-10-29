"""Validate mature drivers over real local TCP and HTTPS certificates using credential-free
fixtures.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import ipaddress
import json
from pathlib import Path
import socketserver
import ssl
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch

from app.services import connector_database as db
from app.services import connector_database_extra as extra
from test_connector_database_extra import spec, health, result, http_server


@contextmanager
def certificate():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "connector-fixture")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1")), x509.DNSName("localhost")]), False)
        .sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "cert.pem").write_text(pem, encoding="utf-8")
        (root / "key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(root / "cert.pem", root / "key.pem")
        yield pem, context


@contextmanager
def mongo_server(auth_failure=False, read_failure=False):
    from bson import BSON, Int64
    commands = []
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            while True:
                header = self.rfile.read(16)
                if not header:
                    return
                length, request_id, _, opcode = struct.unpack("<iiii", header)
                payload = self.rfile.read(length - 16)
                if opcode == 2004:
                    end = payload.index(b"\x00", 4)
                    command = BSON(payload[end + 9:]).decode()
                elif opcode == 2013:
                    if payload[4] != 0:
                        raise AssertionError("fixture expects BSON body section")
                    command = BSON(payload[5:]).decode()
                else:
                    raise AssertionError("unexpected wire opcode")
                commands.append(command)
                action = next(iter(command)).lower()
                if action in {"hello", "ismaster"}:
                    reply = {"ok": 1.0, "ismaster": True, "helloOk": True, "minWireVersion": 0, "maxWireVersion": 25,
                             "maxBsonObjectSize": 16777216, "maxMessageSizeBytes": 48000000, "maxWriteBatchSize": 100000}
                    if "saslSupportedMechs" in command:
                        reply["saslSupportedMechs"] = ["SCRAM-SHA-256"]
                elif action == "saslstart":
                    reply = {"ok": 0, "code": 18, "codeName": "AuthenticationFailed", "errmsg": "private-user-private-password"}
                elif action == "ping":
                    reply = {"ok": 1.0}
                elif action == "listcollections":
                    if "batchSize" in command or set(command.get("cursor", {})) != {"batchSize"}:
                        raise AssertionError("listCollections batchSize belongs inside cursor")
                    reply = {"ok": 1.0, "cursor": {"id": Int64(77), "ns": "fixture.$cmd.listCollections",
                             "firstBatch": [{"name": "alpha"}, {"name": "beta"}]}}
                elif action == "find":
                    if read_failure:
                        reply = {"ok": 0, "code": 13, "codeName": "Unauthorized", "errmsg": "private-database"}
                    else:
                        reply = {"ok": 1.0, "cursor": {"id": Int64(0), "ns": "fixture.sample",
                                 "firstBatch": [{"_id": 1, "title": "测试"}, {"_id": 2, "title": "next"}]}}
                elif action == "killcursors":
                    reply = {"ok": 1.0, "cursorsKilled": [Int64(77)], "cursorsNotFound": [], "cursorsAlive": [], "cursorsUnknown": []}
                elif action == "endsessions":
                    reply = {"ok": 1.0}
                else:
                    reply = {"ok": 0, "code": 59, "errmsg": "unsupported fixture command"}
                encoded = BSON.encode(reply)
                if opcode == 2004:
                    response = struct.pack("<iqii", 0, 0, 0, 1) + encoded
                    op = 1
                else:
                    response = struct.pack("<i", 0) + b"\x00" + encoded
                    op = 2013
                try:
                    self.wfile.write(struct.pack("<iiii", len(response) + 16, request_id + 1000, request_id, op) + response)
                    self.wfile.flush()
                except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                    return
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


class DatabaseProtocolTests(unittest.TestCase):
    def test_https_custom_ca_required_and_accepted_no_verify_false(self):
        with certificate() as (pem, context):
            with http_server(lambda _: (200, {}, {"username": "reader"}), context) as (url, calls):
                target = spec("elasticsearch", ES_URL=url, ES_API_KEY="fixture-key")
                self.assertEqual(health(target)["connectionState"], "error")
                self.assertEqual(len(calls), 0)
                target["env"]["TLS_CA_PEM"] = pem.replace("\n", "\\n")
                self.assertEqual(health(target)["connectionState"], "verified")
                self.assertEqual(len(calls), 1)

    def test_mongo_real_driver_ping_find_and_cursor_cleanup(self):
        import pymongo
        self.assertEqual(pymongo.__version__, "4.18.3")
        with mongo_server() as (port, commands):
            target = spec("mongodb", MONGO_HOST="127.0.0.1", MONGO_PORT=str(port), MONGO_DATABASE="fixture")
            metadata = health(target)
            self.assertTrue(metadata["ok"])
            self.assertFalse(metadata["authenticationTested"])
            data = result(target, "find_documents", {"collection": "sample", "filter": {"age": {"$gte": 18}}, "limit": 1, "skip": 2})
            self.assertEqual(len(data["documents"]), 1)
            self.assertEqual(data["documents"][0]["title"], "测试")
            query = next(c for c in commands if "find" in c)
            self.assertEqual(query["filter"], {"age": {"$gte": 18}})
            self.assertEqual(query["sort"], {"_id": 1})
            self.assertEqual(query["limit"], 1)
            self.assertEqual(query["skip"], 2)
            self.assertGreater(query["maxTimeMS"], 0)
            page = result(target, "list_collections", {"limit": 1, "name_prefix": "a."})
            self.assertEqual(page["collections"], ["alpha"])
            self.assertTrue(page["has_more"])
            self.assertTrue(any("killCursors" in command for command in commands))
            names = next(c for c in commands if "listCollections" in c)
            self.assertEqual(names["filter"], {"name": {"$regex": "^a\\."}})
            self.assertEqual(names["cursor"], {"batchSize": 2})
            self.assertNotIn("batchSize", names)
            self.assertFalse(any(any(k in c for k in ("insert", "update", "delete", "aggregate")) for c in commands))

    def test_mongo_real_sasl_rejection_and_unauthorized_read_are_safe(self):
        with mongo_server(auth_failure=True) as (port, commands):
            target = spec("mongodb", MONGO_HOST="127.0.0.1", MONGO_PORT=str(port), MONGO_DATABASE="fixture", MONGO_USER="reader", MONGO_PASSWORD="private-password")
            data = health(target)
            self.assertEqual(data["connectionState"], "needs_auth")
            self.assertFalse(data["ok"])
            self.assertNotIn("private", json.dumps(data))
            self.assertTrue(any("saslStart" in c for c in commands))
        with mongo_server(read_failure=True) as (port, _):
            target = spec("mongodb", MONGO_HOST="127.0.0.1", MONGO_PORT=str(port), MONGO_DATABASE="fixture")
            with self.assertRaisesRegex(ValueError, "授权失败") as raised:
                result(target, "find_documents", {"collection": "sample"})
            self.assertNotIn("private", str(raised.exception))

    def test_mongo_tls_ca_is_real_file_and_always_removed(self):
        import pymongo
        with certificate() as (pem, _):
            _, values = db.config(spec("mongodb", MONGO_HOST="mongo.example.com", MONGO_DATABASE="fixture", TLS_CA_PEM=pem.replace("\n", "\\n")))
            created = []
            def client(**kwargs):
                self.assertTrue(kwargs["tls"])
                path = Path(kwargs["tlsCAFile"])
                self.assertTrue(path.is_file())
                self.assertEqual(path.read_text(encoding="utf-8"), pem)
                self.assertEqual(kwargs["socketTimeoutMS"], 3000)
                self.assertEqual(kwargs["timeoutMS"], 3000)
                created.append(path)
                raise RuntimeError("fixture constructor failed")
            with patch.object(pymongo, "MongoClient", side_effect=client), self.assertRaises(RuntimeError):
                with extra._mongo_connection(values, 3):
                    pass
            self.assertEqual(len(created), 1)
            self.assertFalse(created[0].exists())

    def test_empty_optional_defaults_and_extra_arguments(self):
        _, values = db.config(spec("redis", REDIS_HOST="localhost", REDIS_PORT="", REDIS_DB="", REDIS_TLS=""))
        self.assertEqual(values["REDIS_PORT"], "6379")
        self.assertEqual(values["REDIS_TLS"], "true")
        for kind, name, args in [("redis", "ping", {"command": "FLUSHALL"}), ("mongodb", "find_documents", {"collection": "sample", "pipeline": []})]:
            with self.assertRaises(ValueError):
                extra._arguments(kind, name, args)


if __name__ == "__main__":
    unittest.main()
