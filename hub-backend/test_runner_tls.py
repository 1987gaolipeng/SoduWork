"""Real loopback WSS and gateway HTTPS checks without accounts or external network."""
import asyncio
import ipaddress
import os
import ssl
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import truststore
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from app.services import local_stream, runner_tls

# A sentinel detects static-bundle fallback without adding certifi to the
# Runner-only build environment. All TLS handshakes still use real contexts.
certifi = SimpleNamespace(where=Mock(side_effect=AssertionError("bundled roots")))


def certificate(directory, *, hostname="localhost"):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname),
            *([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))] if hostname == "localhost" else [])]), False)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
            key_encipherment=True, data_encipherment=False, key_agreement=False,
            key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), True)
        # Apple's native verifier requires an explicit TLS server purpose.
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
        .sign(key, hashes.SHA256()))
    cert_path, key_path = directory / "cert.pem", directory / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return cert_path, context


class RunnerTLSTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-runner-tls-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("SSL_CERT_FILE", None)
        os.environ.pop("SSL_CERT_DIR", None)
        bundle = patch.dict("sys.modules", {"certifi": certifi})
        bundle.start()
        self.addCleanup(bundle.stop)

    def test_native_context_does_not_load_build_host_paths_or_bundled_roots(self):
        with (patch.object(ssl, "get_default_verify_paths", side_effect=AssertionError("build host path")),
              patch.object(certifi, "where", side_effect=AssertionError("bundled roots"))):
            context = runner_tls.websocket_options("wss://fixture.invalid")["ssl"]
        self.assertIsInstance(context, truststore.SSLContext)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_plaintext_keeps_existing_transport_defaults(self):
        with patch.object(truststore, "SSLContext", side_effect=AssertionError("must not load native trust")):
            self.assertEqual(runner_tls.websocket_options("ws://localhost"), {})
            self.assertEqual(runner_tls.websocket_options("https://fixture.invalid"), {})

    def test_missing_or_corrupt_explicit_ca_fails_closed(self):
        bad = self.root / "bad.pem"
        bad.write_text("not a certificate")
        for path in (self.root / "missing.pem", bad):
            with self.subTest(path=path), patch.dict(os.environ, SSL_CERT_FILE=str(path)):
                with self.assertRaises((OSError, ssl.SSLError)):
                    runner_tls.websocket_options("wss://fixture.invalid")

    async def exchange(self, server_context, *, success):
        async def echo(socket):
            await socket.send(await socket.recv())
        async with serve(echo, "127.0.0.1", 0, ssl=server_context) as server:
            url = f"wss://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            options = runner_tls.websocket_options(url)
            if success:
                async with connect(url, proxy=None, **options) as socket:
                    await socket.send("verified")
                    self.assertEqual(await socket.recv(), "verified")
            else:
                with self.assertRaises(ssl.SSLCertVerificationError):
                    async with connect(url, proxy=None, **options):
                        self.fail("untrusted peer accepted")

    async def test_real_wss_uses_native_trust_without_explicit_ca(self):
        cert, context = certificate(self.root)
        native = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        native.load_verify_locations(cafile=str(cert))
        with patch.object(truststore, "SSLContext", return_value=native) as factory:
            await self.exchange(context, success=True)
        factory.assert_called_once_with(ssl.PROTOCOL_TLS_CLIENT)

    async def test_explicit_private_ca_does_not_load_public_or_default_roots(self):
        cert, context = certificate(self.root)
        with patch.dict(os.environ, SSL_CERT_FILE=str(cert)), \
                patch.object(certifi, "where", side_effect=AssertionError("explicit trust loaded public roots")), \
                patch.object(ssl.SSLContext, "load_default_certs", side_effect=AssertionError("explicit trust loaded default roots")):
            await self.exchange(context, success=True)

    async def test_explicit_unrelated_ca_rejects_a_bundled_server_certificate(self):
        cert, context = certificate(self.root)
        other = self.root / "other"
        other.mkdir()
        unrelated, _ = certificate(other)
        with patch.dict(os.environ, SSL_CERT_FILE=str(unrelated)), \
                patch.object(certifi, "where", return_value=str(cert)):
            await self.exchange(context, success=False)

    async def test_explicit_ca_directory_does_not_add_bundled_roots(self):
        cert, context = certificate(self.root)
        capath = self.root / "private-roots"
        capath.mkdir()
        with patch.dict(os.environ, SSL_CERT_DIR=str(capath)), \
                patch.object(certifi, "where", return_value=str(cert)):
            await self.exchange(context, success=False)

    def test_invalid_explicit_ca_configuration_never_falls_back(self):
        cert, _ = certificate(self.root)
        malformed = self.root / "invalid.pem"
        malformed.write_text("not a certificate")
        for override in (
                {"SSL_CERT_FILE": str(self.root / "missing.pem")},
                {"SSL_CERT_FILE": str(self.root)},
                {"SSL_CERT_FILE": str(malformed)},
                {"SSL_CERT_FILE": " "},
                {"SSL_CERT_DIR": str(self.root / "missing-directory")},
                {"SSL_CERT_DIR": str(cert)},
                {"SSL_CERT_FILE": str(cert), "SSL_CERT_DIR": str(self.root / "missing-directory")},
        ):
            with self.subTest(override=override), patch.dict(os.environ, override), \
                    patch.object(certifi, "where") as bundle:
                with self.assertRaises((OSError, ValueError)):
                    runner_tls.websocket_options("wss://fixture.invalid")
                bundle.assert_not_called()

    async def test_untrusted_certificate_is_rejected(self):
        _, context = certificate(self.root)
        await self.exchange(context, success=False)

    async def test_trusted_certificate_for_wrong_hostname_is_rejected(self):
        cert, context = certificate(self.root, hostname="wrong.invalid")
        with patch.dict(os.environ, SSL_CERT_FILE=str(cert)):
            await self.exchange(context, success=False)

    async def gateway_check(self, server_context, *, status=401):
        requests = []

        async def respond(reader, writer):
            try:
                requests.append(await reader.readuntil(b"\r\n\r\n"))
                writer.write(f"HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\n"
                             "Connection: close\r\n\r\n".encode("ascii"))
                await writer.drain()
            finally:
                writer.close()
                try:
                    await writer.wait_closed()
                except ConnectionResetError:
                    pass  # Native verification can reject after the TLS handshake.

        server = await asyncio.start_server(respond, "127.0.0.1", 0, ssl=server_context)
        async with server:
            base = f"https://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1"
            result = await asyncio.to_thread(local_stream._llm_gate_check,
                {"needs_llm": True}, {"llm": {"base": base, "key": "fixture-model-secret"}})
        return result, requests

    async def test_gateway_https_uses_explicit_ca_without_proxy(self):
        cert, context = certificate(self.root)
        # A broken configured proxy must not intercept the direct model probe.
        with (patch.object(certifi, "where", side_effect=AssertionError("bundled roots")),
              patch.dict(os.environ, HTTPS_PROXY="http://127.0.0.1:1",
                         https_proxy="http://127.0.0.1:1", NO_PROXY="", no_proxy="",
                         SSL_CERT_FILE=str(cert))):
            for status in (200, 401, 403, 404, 500):
                with self.subTest(status=status):
                    result, requests = await self.gateway_check(context, status=status)
                    self.assertEqual(result, "")
                    self.assertEqual(len(requests), 1)
                    self.assertTrue(requests[0].startswith(b"GET /v1/models HTTP/1.1\r\n"))
                    self.assertNotIn(b"fixture-model-secret", requests[0])

    async def test_gateway_uses_system_context_when_no_ca_file_is_configured(self):
        cert, context = certificate(self.root)
        # Supply a synthetic system trust anchor without changing the host's
        # Keychain. The TLS handshake and certificate checks remain real.
        native = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        native.load_verify_locations(cafile=str(cert))
        with (patch.object(truststore, "SSLContext", return_value=native) as factory,
              patch.object(certifi, "where", side_effect=AssertionError("bundled roots"))):
            result, requests = await self.gateway_check(context)
        factory.assert_called_once_with(ssl.PROTOCOL_TLS_CLIENT)
        self.assertEqual(result, "")
        self.assertEqual(len(requests), 1)

    async def test_gateway_https_rejects_untrusted_certificate(self):
        _, context = certificate(self.root)
        result, requests = await self.gateway_check(context)
        self.assertIn("TLS 证书校验失败", result)
        self.assertEqual(requests, [])

    async def test_gateway_https_rejects_trusted_certificate_for_wrong_hostname(self):
        cert, context = certificate(self.root, hostname="wrong.invalid")
        with patch.dict(os.environ, SSL_CERT_FILE=str(cert)):
            result, requests = await self.gateway_check(context)
        self.assertIn("TLS 证书校验失败", result)
        self.assertEqual(requests, [])

    async def test_gateway_https_missing_or_corrupt_explicit_ca_returns_error(self):
        _, context = certificate(self.root)
        bad = self.root / "bad.pem"
        bad.write_text("not a certificate")
        for path in (self.root / "missing.pem", bad):
            with self.subTest(path=path), patch.dict(os.environ, SSL_CERT_FILE=str(path)):
                result, requests = await self.gateway_check(context)
                self.assertIn("直连失败", result)
                self.assertNotIn(str(self.root), result)
                self.assertEqual(requests, [])

    async def test_native_rejection_never_falls_back_to_bundled_roots(self):
        cert, context = certificate(self.root)
        rejection = ssl.SSLCertVerificationError(1, "fixture-native-trust-rejection")
        native = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        native.load_verify_locations(cafile=str(cert))
        with (patch.object(truststore, "SSLContext", return_value=native),
              patch("truststore._api._verify_peercerts_impl", side_effect=rejection) as verify,
              patch.object(certifi, "where", return_value=str(cert)) as bundled):
            result, requests = await self.gateway_check(context)
        self.assertIn("TLS 证书校验失败", result)
        self.assertEqual(requests, [])
        verify.assert_called_once()
        bundled.assert_not_called()

    async def test_missing_native_verifier_fails_closed(self):
        _, context = certificate(self.root)
        with patch.dict("sys.modules", {"truststore": None}):
            result, requests = await self.gateway_check(context)
        self.assertIn("直连失败", result)
        self.assertEqual(requests, [])


if __name__ == "__main__":
    unittest.main()
