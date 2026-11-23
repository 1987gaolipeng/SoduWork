"""Verify real HTTPS in frozen Runner networking components with disposable CAs.

This freezes the production modules, not the complete desktop or Runner recipe.
The fixture adds a disposable anchor to real native contexts without changing
the host trust store. Transport, hostname and certificate checks execute normally.
Explicit CA overrides are also verified independently of native default trust.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading


PAYLOAD = b"SoduWork frozen TLS fixture\n"
WORKER = r'''
import hashlib
import importlib
import json
import os
from pathlib import Path
import ssl
import sys
import urllib.request

import truststore
from app.services import local_stream, managed_agent_network

root, good, unknown, wrong_host, mode = sys.argv[1:]
root = Path(root)
verifier_name = {"darwin": "truststore._macos", "win32": "truststore._windows"}.get(
    sys.platform, "truststore._openssl")
verifier = importlib.import_module(verifier_name)
frozen = bool(getattr(sys, "frozen", False))
if frozen:
    assert Path(verifier.__file__).resolve().is_relative_to(Path(sys._MEIPASS).resolve())
os.environ["SSL_CERT_FILE"] = ""
os.environ["SSL_CERT_DIR"] = ""
default_source = "empty OpenSSL CA environment paths"
if sys.platform == "win32":
    # Python adds Windows CA/ROOT certificates independently of OpenSSL paths.
    # Keep those roots: they cannot contain this run's newly generated fixture CA.
    default_source += "; Windows native certificate store retained"
empty = ssl.create_default_context()
paths = ssl.get_default_verify_paths()
assert paths.cafile is None and paths.capath is None, "OpenSSL fixture still has default CA paths"
if sys.platform != "win32":
    assert empty.cert_store_stats()["x509_ca"] == 0, "OpenSSL fixture still has default roots"
assert empty.verify_mode == ssl.CERT_REQUIRED and empty.check_hostname

# Add a fixture anchor; keep native certificate verification and production
# transport intact. Explicit overrides must bypass this native default factory.
native_context = truststore.SSLContext
def fixture_context(protocol):
    context = native_context(protocol)
    context.load_verify_locations(cafile=str(root / "trusted/ca.pem"))
    return context
truststore.SSLContext = fixture_context
if mode == "explicit-trusted":
    os.environ["SSL_CERT_FILE"] = str(root / "trusted/ca.pem")
elif mode == "explicit-unrelated":
    os.environ["SSL_CERT_FILE"] = str(root / "unrelated/ca.pem")
elif mode == "explicit-missing":
    os.environ["SSL_CERT_FILE"] = str(root / "missing-ca.pem")
else:
    assert mode == "native"

checks = []
for name, url in (("trusted", good), ("unknown", unknown), ("hostname", wrong_host)):
    expected = name == "trusted" and mode in ("native", "explicit-trusted")
    try:
        with managed_agent_network.open_download(urllib.request.Request(url + "/archive"), timeout=5) as response:
            accepted = response.read() == b"SoduWork frozen TLS fixture\n"
            reason = ""
    except Exception as error:
        accepted = False
        reason = managed_agent_network.error_label(error)
    checks.append({"path": "download", "target": name, "accepted": accepted,
                   "expected": expected, "reason": reason})
    reason = local_stream._llm_gate_check({"needs_llm": True}, {"llm": {"base": url}})
    checks.append({"path": "gateway-preflight", "target": name, "accepted": not reason,
                   "expected": expected, "reason": reason})
report = {"frozen": frozen, "python": sys.version.split()[0], "openssl": ssl.OPENSSL_VERSION,
          "defaultCAcount": empty.cert_store_stats()["x509_ca"],
          "defaultTrustFixture": default_source,
          "nativeVerifier": verifier_name,
          "fixtureCAsha256": hashlib.sha256((root / "trusted/ca.pem").read_bytes()).hexdigest(),
          "mode": mode, "checks": checks,
          "ok": all(row["accepted"] == row["expected"] for row in checks)}
print(json.dumps(report, ensure_ascii=True))
raise SystemExit(0 if report["ok"] else 1)
'''


def certificates(root: Path) -> tuple[Path, Path, Path]:
    """Create a CA and a localhost-only certificate without touching system trust."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.now(timezone.utc)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "SoduWork TLS acceptance CA")])
    ca = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
          .public_key(key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=2))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
          .sign(key, hashes.SHA256()))
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
            .issuer_name(subject).public_key(leaf_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=2))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    root.mkdir(parents=True)
    paths = tuple(root / name for name in ("ca.pem", "leaf.pem", "leaf-key.pem"))
    paths[0].write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    paths[1].write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    paths[2].write_bytes(leaf_key.private_bytes(serialization.Encoding.PEM,
                         serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    paths[2].chmod(0o600)
    return paths


def serve(stack: ExitStack, leaf: Path, key: Path) -> ThreadingHTTPServer:
    class Fixture(BaseHTTPRequestHandler):
        def do_GET(self):
            body = PAYLOAD if self.path == "/archive" else b'{"data":[]}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(leaf, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.02), daemon=True)
    thread.start()

    def close():
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        assert not thread.is_alive(), "TLS fixture did not stop"

    stack.callback(close)
    return server


def environment(root: Path) -> dict[str, str]:
    clean = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT") if key in os.environ}
    for name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
                 "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "SODUWORK_DATA_ROOT"):
        folder = root / name.lower()
        folder.mkdir(parents=True, exist_ok=True)
        clean[name] = str(folder)
    clean.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1",
                 HTTP_PROXY="", HTTPS_PROXY="", ALL_PROXY="", http_proxy="", https_proxy="", all_proxy="",
                 NO_PROXY="localhost,127.0.0.1", no_proxy="localhost,127.0.0.1",
                 SSL_CERT_FILE="", SSL_CERT_DIR="")
    return clean


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="Directory for JSON evidence and the build log")
    parser.add_argument("--python", default=sys.executable, help="Isolated interpreter with Runner/build dependencies")
    parser.add_argument("--backend", type=Path, default=Path(__file__).resolve().parent,
                        help="Backend checkout to verify, including a clean baseline for regression comparison")
    parser.add_argument("--source-only", action="store_true", help="Run the same transport checks without freezing")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    backend = args.backend.resolve(strict=True)
    assert (backend / "app/services/local_stream.py").is_file(), "Not a backend checkout"
    reports = []
    with ExitStack() as stack:
        root = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="soduwork-frozen-tls-"))).resolve()
        worker = root / "tls_probe.py"
        worker.write_text(WORKER, encoding="utf-8")
        env = environment(root / "profile")
        if args.source_only:
            command = [args.python, str(worker)]
            env["PYTHONPATH"] = str(backend)
        else:
            build = [args.python, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                     "--name", "soduwork-tls-probe", "--paths", str(backend), "--hidden-import",
                     {"darwin": "truststore._macos", "win32": "truststore._windows"}.get(
                         sys.platform, "truststore._openssl"),
                     "--add-data", str(backend / "app/agent_catalog.json") + os.pathsep + "app",
                     "--distpath", str(root / "dist"), "--workpath", str(root / "build"),
                     "--specpath", str(root), str(worker)]
            with (output / "build.log").open("wb") as log:
                subprocess.run(build, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
                               timeout=600, check=True)
            command = [str(root / "dist" / ("soduwork-tls-probe.exe" if os.name == "nt" else "soduwork-tls-probe"))]
        _, leaf, key = certificates(root / "trusted")
        _, other_leaf, other_key = certificates(root / "unknown")
        certificates(root / "unrelated")
        trusted = serve(stack, leaf, key)
        unknown = serve(stack, other_leaf, other_key)
        good = "https://localhost:%d" % trusted.server_port
        bad = "https://localhost:%d" % unknown.server_port
        wrong_host = "https://127.0.0.1:%d" % trusted.server_port
        for mode in ("native", "explicit-trusted", "explicit-unrelated", "explicit-missing"):
            result = subprocess.run([*command, str(root), good, bad, wrong_host, mode],
                                    cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", timeout=60)
            try:
                report = json.loads(result.stdout.strip().splitlines()[-1])
            except (IndexError, json.JSONDecodeError):
                raise RuntimeError("TLS probe returned no JSON: " + result.stderr[-2000:]) from None
            reports.append(report)
            report["exitCode"] = result.returncode
            report["ok"] = report["ok"] and result.returncode == 0
            print(("PASS" if result.returncode == 0 and report["ok"] else "FAIL") + " " + mode, flush=True)
        evidence = {"ok": all(row["ok"] for row in reports),
                    "scope": "source networking components" if args.source_only else "frozen networking components",
                    "completeRunnerBuild": False, "productionRequests": False, "platform": sys.platform,
                    "sourceHashes": {name: hashlib.sha256((backend / "app/services" / name).read_bytes()).hexdigest()
                                     for name in ("managed_agent_network.py", "local_stream.py", "runtime_tls.py")
                                     if (backend / "app/services" / name).is_file()}, "runs": reports}
        (output / "report.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return 0 if evidence["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
