"""Disposable local PostgreSQL + Redis validation of shared auth transactions.

Run from hub-backend with SODUWORK_TEST_REDIS_SERVER set when needed. This
script accepts no database URL and refuses nonlocal Docker endpoints. It owns
one randomly named container and removes only that container after the tests.
SODUWORK_AUTH_CACHE_SOURCE may identify another local Hub checkout to validate.
"""
from __future__ import annotations

import asyncio
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
import uuid

import httpx
from fastapi import Depends, FastAPI

LOCAL_HUB = Path(__file__).resolve().parents[1]
SOURCE_HUB = Path(os.environ.get("SODUWORK_AUTH_CACHE_SOURCE", str(LOCAL_HUB))).resolve()
sys.path.insert(0, str(LOCAL_HUB))
sys.path.insert(0, str(SOURCE_HUB))
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-auth-cache-postgres-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-auth-cache-postgres-tests")

from sqlalchemy import event, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.db import get_session
from app.deps import current_client, identity_only
from app.models import Client, Role, User
from app.services import auth_cache_transactions, auth_principals, device_auth, shared_auth_cache
from app.services.auth_cache_transactions import AuthSession
from test_auth_cache_transactions import AuthCacheTransactionTests
from test_shared_auth_cache import IsolatedRedisTestCase


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True,
                          text=True, timeout=30)


class PostgresAuthCacheTests(AuthCacheTransactionTests):
    container_id = None

    @classmethod
    def setUpClass(cls):
        endpoint = json.loads(docker("context", "inspect", "--format",
                                     "{{json .Endpoints.docker.Host}}").stdout)
        actual = os.environ.get("DOCKER_HOST") or endpoint
        if not str(actual).startswith("unix://"):
            raise RuntimeError("Refusing a nonlocal Docker endpoint")
        docker("version", "--format", "{{.Server.Version}}")
        # Use the already-present image; this diagnostic never pulls an image.
        docker("image", "inspect", "postgres:16-bookworm")
        name = "soduwork-auth-cache-pg-" + uuid.uuid4().hex[:12]
        cls.container_id = docker(
            "run", "--detach", "--rm", "--name", name,
            "--label", "soduwork.test=shared-auth-cache",
            "--publish", "127.0.0.1::5432",
            "--env", "POSTGRES_PASSWORD=isolated-auth-cache-test-password",
            "--env", "POSTGRES_DB=auth_cache_test",
            "postgres:16-bookworm").stdout.strip()
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                ready = docker("exec", cls.container_id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres",
                               "-d", "auth_cache_test", check=False)
                if ready.returncode == 0:
                    break
                time.sleep(.1)
            else:
                raise RuntimeError("Disposable PostgreSQL failed to become ready")
            port_mapping = json.loads(docker(
                "inspect", "--format", "{{json .NetworkSettings.Ports}}", cls.container_id).stdout)
            mapping = port_mapping["5432/tcp"][0]
            if mapping["HostIp"] != "127.0.0.1":
                raise RuntimeError("Disposable PostgreSQL is not bound to loopback")
            cls.pg_url = ("postgresql+asyncpg://postgres:isolated-auth-cache-test-password"
                          f"@127.0.0.1:{int(mapping['HostPort'])}/auth_cache_test")
            super().setUpClass()
            print(f"Isolated PostgreSQL container {name}; source {SOURCE_HUB}", flush=True)
        except BaseException:
            cls._stop_postgres()
            raise

    @classmethod
    def _stop_postgres(cls):
        if cls.container_id:
            docker("rm", "--force", cls.container_id, check=False)
            cls.container_id = None

    @classmethod
    def tearDownClass(cls):
        try:
            super().tearDownClass()
        finally:
            cls._stop_postgres()

    async def asyncSetUp(self):
        await IsolatedRedisTestCase.asyncSetUp(self)
        self.schema = "auth_cache_" + uuid.uuid4().hex
        self.admin_engine = create_async_engine(self.pg_url)
        async with self.admin_engine.begin() as connection:
            await connection.execute(text('CREATE SCHEMA "' + self.schema + '"'))
        self.engine = create_async_engine(self.pg_url, connect_args={"server_settings": {
            "search_path": self.schema, "statement_timeout": "5000",
            "application_name": "isolated-auth-cache-tests",
        }})
        self.sessions = async_sessionmaker(
            self.engine, expire_on_commit=False, class_=AsyncSession,
            sync_session_class=AuthSession)
        self.read_sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(
                sync, tables=[Client.__table__, User.__table__, Role.__table__]))
        async with self.read_sessions() as session:
            session.add_all([
                Role(id="reader", name="Reader", permissions=["read", "write"]),
                User(id="alice", username="alice", is_active=True, auth_version=1,
                     role_id="reader", org_id="department-a"),
                User(id="bob", username="bob", is_active=True, auth_version=1,
                     role_id="reader", org_id="department-a"),
                Client(id="pc", user_ref="alice", auth_state="active", auth_version=1,
                       config={"automationConversationV1": 1}),
            ])
            await session.commit()
        self.read_counts = Counter()
        self.cache_patch = patch.object(shared_auth_cache, "get_cache", return_value=self.first)
        self.transaction_patch = patch.object(auth_cache_transactions, "get_cache", return_value=self.first)
        self.cache_patch.start()
        self.transaction_patch.start()
        reads = patch.object(shared_auth_cache, "reads_enabled", return_value=True)
        reads.start()
        self.addCleanup(reads.stop)

    async def asyncTearDown(self):
        try:
            await super().asyncTearDown()
        finally:
            async with self.admin_engine.begin() as connection:
                await connection.execute(text('DROP SCHEMA "' + self.schema + '" CASCADE'))
            await self.admin_engine.dispose()

    async def test_pg_old_snapshot_cannot_refill_after_another_session_commits_revoke(self):
        entered, resume = asyncio.Event(), asyncio.Event()
        async def stale_loader():
            async with self.read_sessions() as session:
                row = (await session.execute(select(User.id, User.is_active).where(
                    User.id == "alice"))).mappings().one()
                snapshot = dict(row)
                entered.set()
                await resume.wait()
                return snapshot
        stale_request = self.start(self.first.load("user", "alice", stale_loader))
        await asyncio.wait_for(entered.wait(), 2)
        async with self.sessions() as session:
            await session.execute(update(User).where(User.id == "alice").values(is_active=False))
            await session.commit()
        self.assertFalse((await self.snapshot("user", "alice", peer=True))["is_active"])
        resume.set()
        await asyncio.wait_for(stale_request, 2)
        self.assertFalse((await self.snapshot("user", "alice"))["is_active"])
        self.assertEqual(self.read_counts["user", "alice"], 1)

    async def test_pg_savepoint_commit_does_not_publish_uncommitted_permissions(self):
        await self.snapshot("role", "reader")
        async with self.sessions() as session:
            transaction = await session.begin()
            async with session.begin_nested():
                role = await session.get(Role, "reader")
                role.permissions = []
                await session.flush()
            # Another connection sees committed facts, never savepoint-only data.
            self.assertEqual((await self.snapshot("role", "reader", peer=True))["permissions"],
                             ["read", "write"])
            await transaction.commit()
        self.assertEqual((await self.snapshot("role", "reader", peer=True))["permissions"], [])

    async def test_pg_actual_device_token_and_role_projection_reject_revoked_owner(self):
        async with self.read_sessions() as session:
            token, _ = device_auth.issue_session(await session.get(Client, "pc"))
            principal, claims = await auth_principals.from_token(session, token)
            self.assertEqual((principal.id, principal.user_ref), ("pc", "alice"))
            self.assertEqual(claims["uid"], "alice")
            self.assertTrue(principal.automation_conversation_v1)
            self.assertEqual(await auth_principals.role_permissions(session, "reader"), {"read", "write"})
            queries = []
            def observe(*_args):
                queries.append(True)
            event.listen(self.engine.sync_engine, "before_cursor_execute", observe)
            try:
                await auth_principals.from_token(session, token)
                await auth_principals.role_permissions(session, "reader")
                self.assertEqual(queries, [], "warm device/user/role auth must not query PostgreSQL")
            finally:
                event.remove(self.engine.sync_engine, "before_cursor_execute", observe)
        async with self.sessions() as session:
            user = await session.get(User, "alice")
            user.is_active = False
            role = await session.get(Role, "reader")
            role.permissions = []
            await session.commit()
        with patch.object(shared_auth_cache, "get_cache", return_value=self.second):
            async with self.read_sessions() as session:
                self.assertEqual(await auth_principals.role_permissions(session, "reader"), set())
                with self.assertRaises(device_auth.DeviceAuthError) as rejected:
                    await auth_principals.from_token(session, token)
                self.assertEqual(rejected.exception.status, 403)

    async def test_pg_json_capabilities_authenticate_without_casting_or_coercion(self):
        values = [None, True, False, 1, 0, 1.0, 1.5, "1", "unexpected", {}, [1]]
        cases = [("missing", {}, False), ("null-config", None, False)] + [
            ("value-" + str(index), {"automationConversationV1": value}, value == 1)
            for index, value in enumerate(values)]
        app = FastAPI()
        async def database():
            async with self.sessions() as session:
                yield session
        app.dependency_overrides[get_session] = database

        @app.get("/identity")
        @identity_only
        async def identity(client=Depends(current_client)):
            return {"id": client.id, "capability": client.automation_conversation_v1}

        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        with patch.object(device_auth, "_LAST_SEEN_WRITES", {}):
            async with httpx.AsyncClient(transport=transport, base_url="http://isolated") as client:
                for name, config, expected in cases:
                    with self.subTest(capability=name):
                        device = Client(id="capability-" + name, user_ref="alice", auth_state="active",
                                        auth_version=1, config=config)
                        async with self.sessions() as session:
                            session.add(device)
                            await session.commit()
                        token, _ = device_auth.issue_session(device)
                        for cache in (self.first, self.second):
                            with patch.object(shared_auth_cache, "get_cache", return_value=cache):
                                response = await client.get("/identity", headers={"Authorization": "Device " + token})
                            self.assertEqual(response.status_code, 200, response.text)
                            self.assertEqual(response.json(), {"id": device.id, "capability": expected})


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PostgresAuthCacheTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
