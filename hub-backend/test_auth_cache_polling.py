"""Real HTTP/SQL/Redis regression for legacy 250 ms device polling.

No authentication dependency override and no production resources. SQL tracing
proves what warm requests read; wall time is reported, never a flaky pass gate.
"""
import asyncio
from contextlib import ExitStack
import contextvars
import json
import os
from pathlib import Path
import statistics
import tempfile
import time
from unittest.mock import patch

import httpx
from fastapi import Depends, FastAPI
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from test_shared_auth_cache import IsolatedRedisTestCase
from app import models
from app.auth import sign_token
from app.db import Base, get_session
from app.deps import current_client, current_ai_client, require_perm
from app.services import auth_cache_transactions, auth_principals, device_auth, shared_auth_cache
from app.services.auth_cache_transactions import AuthSession
from app.api import personal_schedules, account_conversations, conversation_projects, remote_screen
from app.api import clients, cloud_execution_sync, runner_ws, personal_conversation_relay


class AuthenticationHttpFixture(IsolatedRedisTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-auth-http-")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + self.temp.name + "/test.db")
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False, sync_session_class=AuthSession)
        self.device_key = "isolated-auth-polling-device-secret-over-32-characters"
        async with self.sessions() as session:
            session.add_all([
                models.Role(id="reader", name="Reader", permissions=["client.view"]),
                models.User(id="alice", username="alice", is_active=True, auth_version=1, role_id="reader"),
                models.User(id="bob", username="bob", is_active=True, auth_version=1, role_id="reader"),
            ])
            self.tokens = []
            for index in range(24):
                client = models.Client(id=f"poll-device-{index}", user_ref="alice", auth_state="active",
                    secret_hash=device_auth.hash_secret(self.device_key),
                    auth_version=1, config={"automationConversationV1": 1, "largeFixture": "x" * 200_000},
                    model_keys={"fixture-provider": "isolated-never-used"}, git_creds={"fixture": "not-a-secret"})
                session.add(client)
                self.tokens.append(device_auth.issue_session(client)[0])
            await session.commit()
        self.active_cache = contextvars.ContextVar("auth-test-node", default=self.second)
        self.patches = ExitStack()
        self.patches.enter_context(patch.object(shared_auth_cache, "reads_enabled", return_value=True))
        self.patches.enter_context(patch.object(shared_auth_cache, "get_cache", side_effect=self.active_cache.get))
        self.patches.enter_context(patch.object(auth_cache_transactions, "get_cache", side_effect=self.active_cache.get))
        self.patches.enter_context(patch.object(device_auth, "_LAST_SEEN_WRITES", {}))
        self.http = []
        self.apps = []
        for cache in (self.first, self.second):
            app = FastAPI()
            self.apps.append(app)
            app.include_router(personal_schedules.router, prefix="/api/v1")
            for router in (account_conversations.router, conversation_projects.router, remote_screen.router,
                           clients.router, cloud_execution_sync.router, runner_ws.router, personal_conversation_relay.router):
                app.include_router(router)

            def database_for(node_cache):
                async def database():
                    token = self.active_cache.set(node_cache)
                    try:
                        async with self.sessions() as session:
                            yield session
                    finally:
                        self.active_cache.reset(token)
                return database

            app.dependency_overrides[get_session] = database_for(cache)

            @app.get("/test/full-client")
            async def full_client(client=Depends(current_client)):
                return {"owner": client.user_ref, "fixture": client.config.get("largeFixture", "")[:1]}

            @app.get("/test/admin")
            async def admin(user=Depends(require_perm("client.view"))):
                return {"id": user.id}

            @app.get("/test/ai-admission")
            async def ai_admission(client=Depends(current_ai_client)):
                return {"id": client.id}

            self.http.append(httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated"))
        self.sql = []
        event.listen(self.engine.sync_engine, "before_cursor_execute", self.observe)

    def observe(self, _conn, _cursor, statement, _parameters, _context, _many):
        self.sql.append(statement.lower())

    async def asyncTearDown(self):
        for client in self.http:
            await client.aclose()
        self.patches.close()
        event.remove(self.engine.sync_engine, "before_cursor_execute", self.observe)
        await self.engine.dispose()
        self.temp.cleanup()
        await super().asyncTearDown()

    def headers(self, index=0):
        return {"Authorization": "Device " + self.tokens[index]}

    async def inbox(self, node=0, index=0):
        return await self.http[node].post("/api/v1/automation-conversations/inbox", headers=self.headers(index))


class PollingAuthenticationTests(AuthenticationHttpFixture):
    async def test_24_devices_poll_every_250ms_without_auth_sql_or_empty_commits(self):
        for index in range(24):
            self.assertEqual((await self.inbox(index=index)).json(), {"items": []})
        self.sql.clear()
        durations = []
        committed = []
        def commit(_connection):
            committed.append(True)
        event.listen(self.engine.sync_engine, "commit", commit)
        started = time.monotonic()
        async def worker(index):
            for tick in range(8):
                await asyncio.sleep(max(0, started + tick * .25 - time.monotonic()))
                before = time.monotonic()
                result = await self.inbox(node=tick % 2, index=index)
                durations.append((time.monotonic() - before) * 1000)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json(), {"items": []})
        try:
            await asyncio.gather(*(worker(index) for index in range(24)))
        finally:
            event.remove(self.engine.sync_engine, "commit", commit)
        reads = [sql for sql in self.sql if sql.lstrip().startswith("select")]
        self.assertEqual(len(reads), 24 * 8)
        self.assertTrue(all("from ai_schedule_run" in sql for sql in reads))
        self.assertTrue(all("select ai_schedule_run.id, ai_schedule_run.state" in sql for sql in reads))
        self.assertFalse(any(sql.lstrip().startswith(("update", "insert", "delete")) for sql in self.sql))
        self.assertEqual(committed, [])
        ordered = sorted(durations)
        result = {"devices": 24, "intervalMs": 250, "requests": len(durations),
                  "authSql": 0, "businessSelects": len(reads), "commits": 0,
                  "elapsedSeconds": round(time.monotonic() - started, 3),
                  "p50Ms": round(statistics.median(durations), 2),
                  "p95Ms": round(ordered[int(len(ordered) * .95)], 2)}
        print("ISOLATED_AUTH_POLLING " + json.dumps(result), flush=True)

    async def test_revocation_during_250ms_polling_rejects_next_request_on_other_node(self):
        self.assertEqual((await self.inbox()).status_code, 200)
        await asyncio.sleep(.25)
        async with self.sessions() as session:
            await session.execute(update(models.Client).where(models.Client.id == "poll-device-0").values(
                auth_version=models.Client.auth_version + 1, auth_state="revoked"))
            await session.commit()
        await asyncio.sleep(.25)
        self.assertEqual((await self.inbox(node=1)).status_code, 403)
        self.assertEqual((await self.inbox()).status_code, 403)

    async def test_owner_disabled_invalidates_shared_user_without_loading_client_json(self):
        await self.inbox()
        await self.inbox(index=1)
        async with self.sessions() as session:
            user = await session.get(models.User, "alice")
            user.is_active = False
            await session.commit()
        for index in (0, 1):
            self.assertEqual((await self.inbox(node=1, index=index)).status_code, 403)

    async def test_shared_snapshots_do_not_store_business_configuration_or_credentials(self):
        await self.inbox()
        values = []
        async for key in self.redis.scan_iter(match=self.first.prefix + "value:*"):
            values.append(await self.redis.get(key))
        self.assertEqual(len(values), 2)
        for raw in values:
            self.assertLess(len(raw), 2048)
            for field in (b"largeFixture", b"model_keys", b"git_creds", b"password_hash", b"secret_hash"):
                self.assertNotIn(field, raw)

    async def test_other_read_apis_use_real_light_identity_dependency(self):
        await self.inbox()
        routes = ["/api/v1/account-conversations", "/api/v1/conversation-projects",
                  "/api/v1/remote-screen/requests", "/api/v1/team/messages",
                  "/api/v1/cloud-execution-sync", "/api/v1/runners"]
        for route in routes:
            self.sql.clear()
            result = await self.http[1].get(route, headers=self.headers())
            self.assertEqual(result.status_code, 200, (route, result.text[:200]))
            self.assertFalse(any("client.model_keys" in sql or "app_user.password_hash" in sql
                                 for sql in self.sql), route)
        route = "/api/v1/personal-conversation-relay/poll"
        await self.http[0].post(route, headers=self.headers(), json={})
        self.sql.clear()
        result = await self.http[1].post(route, headers=self.headers(), json={})
        self.assertEqual(result.status_code, 200, result.text[:200])
        self.assertFalse(any("client.model_keys" in sql or "app_user.password_hash" in sql for sql in self.sql))

    async def test_full_client_call_keeps_explicit_business_data(self):
        await self.inbox()
        result = await self.http[1].get("/test/full-client", headers=self.headers())
        self.assertEqual(result.json(), {"owner": "alice", "fixture": "x"})

    async def test_role_changes_apply_to_both_admin_sessions(self):
        for user in ("alice", "bob"):
            result = await self.http[0].get("/test/admin", headers={"Authorization": "Bearer " + sign_token(user)})
            self.assertEqual(result.status_code, 200)
        async with self.sessions() as session:
            role = await session.get(models.Role, "reader")
            role.permissions = []
            await session.commit()
        for user in ("alice", "bob"):
            result = await self.http[1].get("/test/admin", headers={"Authorization": "Bearer " + sign_token(user)})
            self.assertEqual(result.status_code, 403)

    async def test_device_transfer_between_cache_check_and_business_load_rejects_old_token(self):
        await self.inbox()
        original = auth_principals.from_token
        async def transfer(*args, **kwargs):
            result = await original(*args, **kwargs)
            async with self.sessions() as session:
                device = await session.get(models.Client, "poll-device-0")
                device_auth.activate(device, await session.get(models.User, "bob"))
                await session.commit()
            return result
        with patch.object(auth_principals, "from_token", side_effect=transfer):
            result = await self.http[1].get("/test/full-client", headers=self.headers())
        self.assertEqual(result.status_code, 401)

    async def test_purpose_specific_tickets_cannot_be_used_for_device_polling(self):
        async with self.sessions() as session:
            device = await session.get(models.Client, "poll-device-0")
            for token in (device_auth.issue_proxy_ticket(device)[0], device_auth.issue_mcp_ticket(device)[0]):
                result = await self.http[0].post("/api/v1/automation-conversations/inbox",
                    headers={"Authorization": "Device " + token})
                self.assertEqual(result.status_code, 401)

    async def test_cached_identity_never_caches_quota_allow_or_blocks_ordinary_inbox(self):
        from app.services.client_access import USER_QUOTA_PREFIX
        async with self.sessions() as session:
            session.add(models.AppSetting(key=USER_QUOTA_PREFIX + "alice",
                value=json.dumps({"mode": "unlimited", "limit": 0})))
            await session.commit()
        self.assertEqual((await self.http[0].get("/test/ai-admission", headers=self.headers())).status_code, 200)
        async with self.sessions() as session:
            setting = await session.get(models.AppSetting, USER_QUOTA_PREFIX + "alice")
            setting.value = json.dumps({"mode": "limited", "limit": 0})
            await session.commit()
        self.assertEqual((await self.inbox(node=1)).status_code, 200)
        self.assertEqual((await self.http[1].get("/test/ai-admission", headers=self.headers())).status_code, 403)
