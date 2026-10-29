"""Same-device account switching through real auth and task HTTP routes.

Isolated SQLite, local files and the encrypted mail outbox; no SMTP, provider,
business database or user credentials are accessed.
"""
import os
import tempfile
from pathlib import Path
import unittest

_root = tempfile.TemporaryDirectory(prefix="soduwork-account-task-isolation-")
os.environ.update(DATABASE_URL="sqlite+aiosqlite:///" + (Path(_root.name) / ".smoke.db").as_posix(),
                  SODUWORK_DATA_ROOT=str(Path(_root.name) / "data"),
                  AUTH_SECRET="isolated-account-task-signing-key", ADMIN_PASS="isolated-admin-password",
                  CLUSTER_REDIS_URL="", DEVICE_AUTH_COMPAT="false", SODUWORK_ENV="development")

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from app import models, automation_models, conversation_handoff_models, session_memory_models, memory_record_models
from app.auth import hash_password
from app.db import Base, SessionLocal, engine
from app.mail_models import MailOutbox
from app.api import attachments, client_auth, client_email_auth, tasks
from app.services import account_mail, client_access, device_auth, task_access
from app.services.account_legal import required_versions

app = FastAPI()
for router in (client_auth.router, client_email_auth.router, tasks.router, attachments.router):
    app.include_router(router)


class AccountTaskIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)
            await connection.run_sync(Base.metadata.create_all)
        client_access._policy_cache = None
        client_access.invalidate_quota()
        self.device = "soduwork-shared-account-fixture"
        self.key = "isolated-device-key-" + "a" * 48
        self.password = "Isolated-account-password-123"
        async with SessionLocal() as session:
            session.add_all([
                models.OrgUnit(id="company", name="Company"),
                models.OrgUnit(id="trial", name="Trial", parent_id="company"),
                models.User(id="alice", username="alice", display_name="Alice", org_id="company",
                            password_hash=hash_password(self.password), is_active=True),
                models.Client(id=self.device, secret_hash=device_auth.hash_secret(self.key), auth_state="pending"),
            ])
            await session.commit()
            await client_access.update_policy(session, {"defaultOrgId": "trial"})
            await account_mail.save_settings(session, {"enabled": True, "host": "smtp.example.test", "port": 465,
                "security": "ssl", "username": "sender@example.test", "senderAddress": "sender@example.test",
                "password": "isolated-mail-password"})
            await session.commit()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated.test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await engine.dispose()

    async def login(self, account):
        response = await self.http.post("/api/v1/client-auth/login", headers={"X-Device-Key": self.key},
            json={"device": self.device, "account": account, "password": self.password})
        self.assertEqual(response.status_code, 200, response.text)
        return {"Authorization": "Device " + response.json()["session"]}

    async def register_bob(self):
        headers = {"X-Device-Key": self.key}
        response = await self.http.post("/api/v1/client-auth/email-challenges", headers=headers,
            json={"device": self.device, "email": "bob@example.test", "purpose": "register"})
        self.assertEqual(response.status_code, 200, response.text)
        challenge = response.json()["challengeId"]
        async with SessionLocal() as session:
            outbox = await session.scalar(select(MailOutbox).where(MailOutbox.challenge_id == challenge))
            code = account_mail.unseal(outbox.payload_encrypted)["code"]
        response = await self.http.post("/api/v1/client-auth/register", headers=headers,
            json={"device": self.device, "email": "bob@example.test", "challengeId": challenge, "code": code,
                  "password": self.password, "consents": required_versions()})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["user"]["orgId"], "trial")
        return {"Authorization": "Device " + response.json()["session"]}

    async def test_registration_on_same_device_cannot_inherit_private_running_requirements(self):
        alice = await self.login("alice")
        created = await self.http.post("/api/v1/tasks", headers=alice,
            json={"title": "Alice private ongoing work", "status": "doing", "visibility": "related"})
        self.assertEqual(created.status_code, 200, created.text)
        tid = created.json()["id"]
        upload = await self.http.post(f"/api/v1/tasks/{tid}/attachments", headers=alice,
            files={"file": ("private.txt", b"Alice private evidence", "text/plain")})
        self.assertEqual(upload.status_code, 200, upload.text)
        aid = upload.json()["id"]
        bob = await self.register_bob()
        old_session = await self.http.get("/api/v1/tasks", headers=alice)
        self.assertEqual(old_session.status_code, 401)
        visible = await self.http.get("/api/v1/tasks", headers=bob)
        self.assertEqual(visible.status_code, 200, visible.text)
        self.assertNotIn(tid, [row["id"] for row in visible.json()])
        for method, path, body in (
            ("GET", f"/tasks/{tid}", None),
            ("GET", f"/tasks/{tid}/events", None),
            ("GET", f"/tasks/{tid}/attachments", None),
            ("POST", f"/attachments/{aid}/access", None),
            ("DELETE", f"/attachments/{aid}", None),
            ("PATCH", f"/tasks/{tid}", {"note": "must not write"}),
            ("PUT", f"/tasks/{tid}", {"title": "must not overwrite"}),
            ("DELETE", f"/tasks/{tid}", None),
        ):
            with self.subTest(method=method, path=path):
                response = await self.http.request(method, "/api/v1" + path, headers=bob, json=body)
                self.assertEqual(response.status_code, 404, response.text)
        async with SessionLocal() as session:
            task = await session.get(models.Task, tid)
            self.assertEqual(task.owner_user_id, "alice")
            self.assertEqual(task.status, "doing")
            self.assertEqual(await task_access.recipient_clients(session, task), [])
        restored = await self.login("alice")
        original = await self.http.get(f"/api/v1/tasks/{tid}", headers=restored)
        self.assertEqual(original.status_code, 200, original.text)
        self.assertIn("executor", original.json()["myRoles"])
        self.assertEqual((await self.http.post(f"/api/v1/attachments/{aid}/access", headers=restored)).status_code, 200)
        self.assertEqual((await self.http.get("/api/v1/tasks", headers=bob)).status_code, 401)

    async def test_explicit_team_sharing_keeps_read_only_collaboration(self):
        alice = await self.login("alice")
        created = await self.http.post("/api/v1/tasks", headers=alice,
            json={"title": "Explicit team request", "visibility": "organization"})
        self.assertEqual(created.status_code, 200, created.text)
        tid = created.json()["id"]
        bob = await self.register_bob()
        response = await self.http.get(f"/api/v1/tasks/{tid}", headers=bob)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["readOnly"])
        self.assertFalse(response.json()["canViewExecution"])
        self.assertNotIn("executor", response.json()["myRoles"])
        self.assertEqual((await self.http.get(f"/api/v1/tasks/{tid}/events", headers=bob)).status_code, 404)


if __name__ == "__main__":
    unittest.main()
