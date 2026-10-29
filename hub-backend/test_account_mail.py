"""Isolated mail persistence, real loopback TLS SMTP, and admin authorization tests."""
import asyncio
import ipaddress
import json
import os
import smtplib
import socketserver
import ssl
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["AUTH_SECRET"] = "account-mail-isolated-fixture-key-32-characters"
os.environ["ADMIN_PASS"] = "account-mail-isolated-admin-password"
os.environ["SODUWORK_ENV"] = "development"
from app.config import Settings
Settings.model_config["env_file"] = None

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi import FastAPI, Header
from sqlalchemy import delete, event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.db import Base, get_session
from app.deps import current_user
from app.models import AppSetting, AuditLog, User
from app.mail_models import MailOutbox
from app.account_models import EmailChallenge, EmailRateLimit
from app.api import admin_mail
from app.services import account_mail as mail


class SMTPHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"220 fixture ESMTP\r\n")
        while line := self.rfile.readline():
            verb = line.split(b" ", 1)[0].strip().upper()
            if verb == b"EHLO":
                self.wfile.write(b"250-fixture\r\n250 AUTH PLAIN\r\n")
            elif verb == b"AUTH":
                self.wfile.write(b"235 authenticated\r\n")
            elif verb in {b"MAIL", b"RCPT", b"RSET"}:
                self.wfile.write(b"250 accepted\r\n")
            elif verb == b"DATA":
                self.wfile.write(b"354 end with dot\r\n")
                data = []
                while (part := self.rfile.readline()) not in {b".\r\n", b""}:
                    data.append(part)
                self.server.messages.append(b"".join(data))
                self.wfile.write(b"250 queued\r\n")
            elif verb == b"QUIT":
                self.wfile.write(b"221 bye\r\n"); break
            else:
                self.wfile.write(b"500 unknown\r\n")


class TLSSMTP(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    def __init__(self, directory):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1)).add_extension(x509.SubjectAlternativeName([
                x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False)
            .sign(key, hashes.SHA256()))
        self.cert = str(Path(directory) / "fixture-cert.pem")
        key_path = str(Path(directory) / "fixture-key.pem")
        Path(self.cert).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        Path(key_path).write_bytes(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(self.cert, key_path)
        self.messages = []
        super().__init__(("127.0.0.1", 0), SMTPHandler)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()
    def get_request(self):
        sock, peer = super().get_request()
        return self.tls.wrap_socket(sock, server_side=True), peer
    def stop(self):
        self.shutdown(); self.server_close(); self.thread.join()


class AccountMailTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-mail-test-")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + (Path(self.tmp.name) / "test.db").as_posix())
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=[
                AppSetting.__table__, AuditLog.__table__, MailOutbox.__table__, EmailChallenge.__table__, EmailRateLimit.__table__]))
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.config = dict(mail.DEFAULTS, enabled=True, username="sender@126.com",
                           senderAddress="sender@126.com", password="fake-smtp-authorization-code")
        self.app = FastAPI(); self.app.include_router(admin_mail.router)
        async def session_dep():
            async with self.factory() as session:
                yield session
        async def user_dep(x_test_admin: str = Header(default="")):
            return SimpleNamespace(id="fixture-admin", is_super=x_test_admin == "yes",
                                   is_active=True, _perms={"identity.manage"} if x_test_admin == "yes" else set(), org_id=None, display_name="fixture")
        self.app.dependency_overrides[get_session] = session_dep
        self.app.dependency_overrides[current_user] = user_dep
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
    async def asyncTearDown(self):
        await self.http.aclose(); await self.engine.dispose(); self.tmp.cleanup()
    async def configure(self, **overrides):
        async with self.factory() as session:
            value = await mail.save_settings(session, {**self.config, **overrides})
            await session.commit(); return value
    async def enqueue(self, **overrides):
        async with self.factory() as session:
            row = await mail.enqueue_mail(session, recipient="recipient@example.com", purpose="login",
                code="482619", expires_at=mail.utcnow() + timedelta(minutes=5), **overrides)
            await session.commit(); return row.id
    async def row(self, mid):
        async with self.factory() as session:
            return await session.get(MailOutbox, mid)

    async def test_idle_delivery_check_uses_one_read_without_writes(self):
        statements = []
        def capture(_connection, _cursor, statement, _parameters, _context, _many):
            statements.append(statement.lstrip().split(None, 1)[0].upper())
        event.listen(self.engine.sync_engine, "before_cursor_execute", capture)
        try:
            self.assertFalse(await mail._delivery_pending(self.factory))
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", capture)
        self.assertEqual(statements, ["SELECT"])

    async def test_delivery_check_includes_due_expired_and_abandoned_mail_only(self):
        now = mail.utcnow()
        past, future = now - timedelta(minutes=1), now + timedelta(minutes=1)
        cases = [
            ("queued", past, future, None, True),
            ("retry", past, future, None, True),
            ("queued", future, future, None, False),
            ("retry", future, past, None, True),
            ("sending", future, future, past, True),
            ("sending", future, future, future, False),
            ("sent", past, past, None, False),
            ("unknown", past, past, None, False),
        ]
        for state, attempt, expiry, lease, expected in cases:
            with self.subTest(state=state, expected=expected, lease=lease):
                async with self.factory() as session:
                    await session.execute(delete(MailOutbox))
                    session.add(MailOutbox(purpose="test", recipient_mask="fixture@example.test",
                                          state=state, next_attempt_at=attempt,
                                          expires_at=expiry, lease_until=lease))
                    await session.commit()
                self.assertEqual(await mail._delivery_pending(self.factory), expected)

    async def test_idle_worker_does_not_open_a_delivery_transaction(self):
        pending, process = AsyncMock(return_value=False), AsyncMock()
        sleep = AsyncMock(side_effect=asyncio.CancelledError)
        with patch("app.db.SessionLocal", self.factory), \
             patch.object(mail, "cleanup", AsyncMock()), \
             patch.object(mail, "_delivery_pending", pending), \
             patch.object(mail, "process_one", process), \
             patch.object(mail.asyncio, "sleep", sleep):
            with self.assertRaises(asyncio.CancelledError):
                await mail.worker_loop()
        pending.assert_awaited_once_with(self.factory)
        process.assert_not_awaited()
        sleep.assert_awaited_once_with(2)

    async def test_ready_worker_drains_mail_without_an_extra_poll_delay(self):
        pending = AsyncMock(side_effect=[True, asyncio.CancelledError])
        process, sleep = AsyncMock(return_value=True), AsyncMock()
        with patch("app.db.SessionLocal", self.factory), \
             patch.object(mail, "cleanup", AsyncMock()), \
             patch.object(mail, "_delivery_pending", pending), \
             patch.object(mail, "process_one", process), \
             patch.object(mail.asyncio, "sleep", sleep):
            with self.assertRaises(asyncio.CancelledError):
                await mail.worker_loop()
        process.assert_awaited_once_with(self.factory)
        sleep.assert_not_awaited()

    async def test_not_configured_never_returns_fake_ready_or_enqueues(self):
        async with self.factory() as session:
            self.assertFalse(await mail.mail_ready(session))
        with self.assertRaises(mail.MailConfigurationError):
            await self.enqueue()

    async def test_credentials_are_encrypted_write_only_and_blank_preserves(self):
        result = await self.configure()
        self.assertTrue(result["passwordConfigured"])
        self.assertNotIn("passwordEncrypted", result)
        async with self.factory() as session:
            stored = await session.get(AppSetting, mail.SETTING_KEY)
            self.assertNotIn(self.config["password"], stored.value)
        await self.configure(password="")
        async with self.factory() as session:
            self.assertEqual((await mail.runtime_config(session))["password"], self.config["password"])

    async def test_bad_key_rotation_fails_closed(self):
        await self.configure()
        with patch.object(mail, "get_settings", return_value=SimpleNamespace(auth_secret="different-isolated-key-32-characters-long", mail_encryption_key="")):
            async with self.factory() as session:
                self.assertFalse(await mail.mail_ready(session))

    async def test_email_identity_and_mail_address_share_idna_validation(self):
        self.assertEqual(mail.address('User@例子.测试'), 'user@xn--fsqu00a.xn--0zwm56d')
        for value in ('first..last@example.com', 'a@-example.com', 'a@example..com'):
            with self.assertRaises(mail.MailConfigurationError):
                mail.address(value)

    async def test_cleanup_removes_only_old_expired_proofs_and_terminal_mail(self):
        await self.configure(); keep = await self.enqueue(); discard = await self.enqueue()
        async with self.factory() as session:
            row = await session.get(MailOutbox, discard); row.state = 'sent'; row.created_at = mail.utcnow() - timedelta(days=31)
            session.add(EmailRateLimit(key='old-rate', count=1, expires_at=mail.utcnow() - timedelta(days=2)))
            session.add(EmailRateLimit(key='active-rate', count=1, expires_at=mail.utcnow() + timedelta(minutes=2)))
            session.add(EmailChallenge(id='old-proof', email_normalized='user@example.com', purpose='login', device_id='fixture', code_hash='hash', expires_at=mail.utcnow() - timedelta(days=2)))
            session.add(EmailChallenge(id='recent-proof', email_normalized='user@example.com', purpose='login', device_id='fixture', code_hash='hash', expires_at=mail.utcnow() - timedelta(minutes=1)))
            await session.commit()
        await mail.cleanup(self.factory)
        self.assertIsNone(await self.row(discard)); self.assertIsNotNone(await self.row(keep))
        async with self.factory() as session:
            self.assertIsNone(await session.get(EmailRateLimit, 'old-rate'))
            self.assertIsNotNone(await session.get(EmailRateLimit, 'active-rate'))
            self.assertIsNone(await session.get(EmailChallenge, 'old-proof'))
            self.assertIsNotNone(await session.get(EmailChallenge, 'recent-proof'))

    async def test_refuses_plaintext_and_header_injection(self):
        for patch_value in ({"security": "none"}, {"host": "smtp.126.com/path"},
                            {"senderName": "Name\r\nBcc: hidden@example.com"}, {"username": "a@b.com\nBcc: c@d.com"}):
            with self.subTest(patch_value=patch_value), self.assertRaises(mail.MailConfigurationError):
                await self.configure(**patch_value)

    async def test_outbox_payload_and_history_never_expose_recipient_or_code(self):
        await self.configure(); mid = await self.enqueue(); row = await self.row(mid)
        self.assertNotIn("482619", row.payload_encrypted)
        self.assertNotIn("recipient@example.com", row.payload_encrypted)
        body = json.dumps(mail.delivery_api(row))
        self.assertNotIn("482619", body); self.assertNotIn("recipient@example.com", body)

    async def test_enqueuing_rolls_back_with_challenge_transaction(self):
        await self.configure()
        async with self.factory() as session:
            row = await mail.enqueue_mail(session, recipient="user@example.com", purpose="login", code="123456",
                                           expires_at=mail.utcnow() + timedelta(minutes=5))
            mid = row.id
            await session.rollback()
        self.assertIsNone(await self.row(mid))

    async def test_expired_mail_never_reaches_smtp(self):
        await self.configure(); mid = await self.enqueue()
        async with self.factory() as session:
            row = await session.get(MailOutbox, mid); row.expires_at = mail.utcnow() - timedelta(seconds=1); await session.commit()
        calls = []
        await mail.process_one(self.factory, sender=lambda *args: calls.append(args))
        self.assertEqual(calls, []); self.assertEqual((await self.row(mid)).state, "expired")
        self.assertEqual((await self.row(mid)).payload_encrypted, "")

    async def test_consumed_or_missing_challenge_is_not_sent(self):
        await self.configure()
        async with self.factory() as session:
            session.add(EmailChallenge(id="consumed-challenge", email_normalized="recipient@example.com",
                purpose="login", device_id="fixture", code_hash="hash",
                expires_at=mail.utcnow() + timedelta(minutes=5), consumed_at=mail.utcnow()))
            await session.commit()
        for challenge_id in ("missing-challenge", "consumed-challenge"):
            mid = await self.enqueue(challenge_id=challenge_id)
            calls = []; await mail.process_one(self.factory, sender=lambda *args: calls.append(args))
            self.assertEqual(calls, []); self.assertEqual((await self.row(mid)).state, "expired")
            self.assertEqual((await self.row(mid)).payload_encrypted, "")

    async def test_concurrent_workers_send_once_and_erase_payload(self):
        await self.configure(); mid = await self.enqueue(); calls = []
        await asyncio.gather(*[mail.process_one(self.factory, sender=lambda *args: calls.append(args[1].id)) for _ in range(2)])
        self.assertEqual(calls, [mid]); self.assertEqual((await self.row(mid)).state, "sent")
        self.assertEqual((await self.row(mid)).payload_encrypted, "")

    async def test_stale_sending_lease_is_uncertain_and_never_sent_again(self):
        await self.configure(); mid = await self.enqueue()
        async with self.factory() as session:
            row = await session.get(MailOutbox, mid); row.state = "sending"; row.lease_until = mail.utcnow() - timedelta(seconds=1); await session.commit()
        calls = []; await mail.process_one(self.factory, sender=lambda *args: calls.append(args))
        self.assertEqual(calls, []); self.assertEqual((await self.row(mid)).state, "unknown")

    async def test_transient_connection_retries_but_uncertain_data_does_not(self):
        await self.configure(); mid = await self.enqueue()
        def transient(*_args): raise mail.MailDeliveryError("SMTP_CONNECTION_FAILED", retryable=True)
        await mail.process_one(self.factory, sender=transient)
        self.assertEqual((await self.row(mid)).state, "retry")
        async with self.factory() as session:
            row = await session.get(MailOutbox, mid); row.next_attempt_at = mail.utcnow(); await session.commit()
        def uncertain(*_args): raise mail.MailDeliveryError("SMTP_RESULT_UNKNOWN", uncertain=True)
        await mail.process_one(self.factory, sender=uncertain)
        self.assertEqual((await self.row(mid)).state, "unknown")
        self.assertEqual((await self.row(mid)).payload_encrypted, "")

    async def test_provider_exceptions_never_leak_secrets_to_log(self):
        await self.configure(); mid = await self.enqueue()
        def explode(*_args): raise RuntimeError("482619 fake-smtp-authorization-code recipient@example.com")
        with self.assertLogs(mail.log, level="INFO") as captured:
            await mail.process_one(self.factory, sender=explode)
        logged = " ".join(captured.output)
        self.assertNotIn("482619", logged); self.assertNotIn("authorization-code", logged)
        self.assertNotIn("recipient@example.com", logged); self.assertIn(mid, logged)

    async def test_actual_local_tls_smtp_auth_and_fixed_test_template(self):
        smtp = TLSSMTP(self.tmp.name)
        try:
            await self.configure(host="localhost", port=smtp.server_address[1])
            async with self.factory() as session:
                row = await mail.enqueue_mail(session, recipient="recipient@example.com", purpose="test", code="",
                                               expires_at=mail.utcnow() + timedelta(minutes=5))
                mid = row.id; await session.commit()
            real_context = ssl.create_default_context(cafile=smtp.cert)
            with patch.object(mail.ssl, "create_default_context", return_value=real_context):
                await mail.process_one(self.factory)
            self.assertEqual((await self.row(mid)).state, "sent")
            self.assertEqual(len(smtp.messages), 1)
            from email import policy
            from email.parser import BytesParser
            message = BytesParser(policy=policy.default).parsebytes(smtp.messages[0])
            self.assertEqual(message["To"], "recipient@example.com")
            self.assertEqual(message["Subject"], "SoduWork · 邮件服务测试")
            self.assertIsNotNone(message["Date"])
            self.assertEqual(message["Message-ID"], "<" + mid + "@126.com>")
            self.assertIn("不会修改账号", message.get_content())
            self.assertNotIn(self.config["password"], str(message))
        finally:
            await asyncio.to_thread(smtp.stop)

    async def test_actual_local_tls_smtp_registration_code(self):
        smtp = TLSSMTP(self.tmp.name)
        try:
            await self.configure(host="localhost", port=smtp.server_address[1])
            async with self.factory() as session:
                row = await mail.enqueue_mail(session, recipient="recipient@example.com", purpose="register",
                    code="048261", expires_at=mail.utcnow() + timedelta(minutes=5))
                mid = row.id
                await session.commit()
            real_context = ssl.create_default_context(cafile=smtp.cert)
            with patch.object(mail.ssl, "create_default_context", return_value=real_context):
                await mail.process_one(self.factory, target_id=mid)
            stored = await self.row(mid)
            self.assertEqual(stored.state, "sent")
            self.assertEqual(stored.payload_encrypted, "")
            self.assertEqual(len(smtp.messages), 1)
            from email import policy
            from email.parser import BytesParser
            message = BytesParser(policy=policy.default).parsebytes(smtp.messages[0])
            self.assertEqual(message["Subject"], "SoduWork · 注册账号")
            self.assertEqual(message["To"], "recipient@example.com")
            self.assertIn("048261", message.get_content())
            self.assertIn("5 分钟", message.get_content())
            self.assertNotIn(self.config["password"], str(message))
        finally:
            await asyncio.to_thread(smtp.stop)

    async def test_definite_recipient_rejection_is_not_uncertain(self):
        await self.configure()
        for status, expected in ((550, "failed"), (450, "retry")):
            with self.subTest(status=status):
                mid = await self.enqueue()
                connection = MagicMock()
                connection.send_message.side_effect = smtplib.SMTPRecipientsRefused({
                    "recipient@example.com": (status, b"private provider diagnostic")})
                with patch.object(mail.smtplib, "SMTP_SSL", return_value=connection):
                    await mail.process_one(self.factory, target_id=mid)
                row = await self.row(mid)
                self.assertEqual(row.state, expected)
                self.assertEqual(row.error_code, "SMTP_RECIPIENT_REJECTED")
                self.assertEqual(bool(row.payload_encrypted), expected == "retry")
                connection.close.assert_called_once()

    async def test_admin_endpoints_reject_ordinary_users(self):
        for method, path, body in [("GET", "/mail-settings", None), ("PUT", "/mail-settings", self.config),
            ("POST", "/mail-settings/test", {"recipient": "user@example.com"}), ("GET", "/mail-deliveries", None)]:
            response = await self.http.request(method, "/api/v1/admin" + path, json=body)
            self.assertEqual(response.status_code, 403, response.text)

    async def test_admin_save_and_test_returns_queued_not_delivery_success(self):
        headers = {"X-Test-Admin": "yes"}
        response = await self.http.put("/api/v1/admin/mail-settings", headers=headers, json=self.config)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn(self.config["password"], response.text)
        response = await self.http.post("/api/v1/admin/mail-settings/test", headers=headers, json={"recipient": "user@example.com"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["queued"]); self.assertEqual(response.json()["delivery"]["state"], "queued")
        response = await self.http.get("/api/v1/admin/mail-deliveries", headers=headers)
        self.assertNotIn("user@example.com", response.text)


if __name__ == "__main__":
    unittest.main()
