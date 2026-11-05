"""Business-bearing HTTP traffic through shared authentication on two Hub apps."""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from sqlalchemy import func, select, update

from test_auth_cache_polling import AuthenticationHttpFixture
from app import automation_models as am, models
from app.account_conversation_models import AccountConversation, AccountConversationMessage
from app.api import account_conversations, personal_models, usage
from app.conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from app.remote_screen_models import RemoteScreenGrant
from app.services import ai_exec, client_access, device_auth, model_catalog


class AuthenticationTrafficTests(AuthenticationHttpFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        for app in self.apps:
            app.include_router(personal_models.router, prefix="/api/v1")
            app.include_router(usage.router)
        self.patches.enter_context(patch.object(account_conversations, "SessionLocal", self.sessions))
        self.patches.enter_context(patch.object(account_conversations.hub, "publish", new=AsyncMock()))
        # Catalog reads and accounting must never perform a credential/model probe.
        self.probe = self.patches.enter_context(patch.object(
            model_catalog, "probe_sync", side_effect=AssertionError("Unexpected live model probe")))
        async with self.sessions() as session:
            bob = models.Client(id="bob-device", user_ref="bob", auth_state="active", auth_version=1,
                secret_hash=device_auth.hash_secret(self.device_key), config={"automationConversationV1": 1})
            session.add(bob)
            self.bob_headers = {"Authorization": "Device " + device_auth.issue_session(bob)[0]}
            session.add_all([
                models.ModelProvider(id="fixture-provider", name="Fixture", kind="openai-compat",
                    base_url="https://model.invalid/v1", api_key="", enabled=True),
                models.ModelDef(id="fixture-chat", provider_id="fixture-provider", name="fixture-chat",
                    label="Fixture chat", enabled=True),
            ])
            await session.commit()

    def checkpoint(self):
        return {"sourceClientId": "poll-device-0", "sourceSessionId": "traffic-native-session",
            "sourceEpoch": "traffic-native-epoch", "sourceRevision": 1, "title": "Traffic conversation",
            "state": "completed", "snapshotComplete": True, "messages": [
                {"id": "traffic-user", "position": 0, "role": "user", "text": "Private Alice question",
                 "createdAt": "2026-11-04T00:00:00Z", "done": True},
                {"id": "traffic-assistant", "position": 1, "role": "assistant", "text": "Private Alice answer",
                 "createdAt": "2026-11-04T00:00:01Z", "done": True}]}

    async def sync_conversation(self, node=0):
        response = await self.http[node].post("/api/v1/account-conversations/sync",
                                             headers=self.headers(), json=self.checkpoint())
        self.assertEqual(response.status_code, 200, response.text[:300])
        return response.json()

    async def seed_screens(self):
        expiry = datetime.now(timezone.utc) + timedelta(hours=1)
        async with self.sessions() as session:
            session.add_all([
                RemoteScreenGrant(id="alice-screen", owner_user_id="alice", source_client_id="poll-device-0",
                    viewer_client_id="poll-device-1", state="pending", expires_at=expiry),
                RemoteScreenGrant(id="bob-screen", owner_user_id="bob", source_client_id="bob-device",
                    viewer_client_id="bob-device", state="pending", expires_at=expiry),
            ])
            await session.commit()

    async def seed_messages(self):
        async with self.sessions() as session:
            session.add_all([
                models.MateMessage(id="message-to-alice", sender_id="bob", recipient_id="alice",
                    client_message_id="to-alice", text="Alice private notification"),
                models.MateMessage(id="message-to-bob", sender_id="alice", recipient_id="bob",
                    client_message_id="to-bob", text="Bob private notification"),
            ])
            await session.commit()

    async def test_enroll_metadata_preserves_warm_identity_but_revocation_blocks_renewal(self):
        self.assertEqual((await self.inbox()).status_code, 200)
        keys = self.first.keys("device", "poll-device-0")[:2]
        before = [await self.redis.hget(key, "generation") for key in keys]
        response = await self.http[1].post("/api/v1/clients/enroll", headers={"X-Device-Key": self.device_key},
            json={"device": "poll-device-0", "name": "Upgraded desktop", "platform": "win32", "version": "1.13.12"})
        self.assertEqual(response.status_code, 200, response.text[:300])
        self.assertTrue(response.json()["session"])
        self.assertEqual([await self.redis.hget(key, "generation") for key in keys], before)
        self.assertNotIn(self.device_key, response.text)
        async with self.sessions() as session:
            device = await session.get(models.Client, "poll-device-0")
            self.assertEqual((device.name, device.app_version), ("Upgraded desktop", "1.13.12"))
            device_auth.revoke(device)
            await session.commit()
        denied = await self.http[0].post("/api/v1/clients/enroll", headers={"X-Device-Key": self.device_key},
                                       json={"device": "poll-device-0", "version": "1.13.12"})
        self.assertEqual(denied.status_code, 403)
        self.assertNotIn("session", denied.json())
        self.assertEqual((await self.inbox(node=1)).status_code, 403)

    async def test_account_sync_is_idempotent_and_transfer_blocks_old_token_and_cross_account_reads(self):
        await self.inbox()
        await self.sync_conversation()
        await self.sync_conversation(node=1)
        listing = await self.http[1].get("/api/v1/account-conversations", headers=self.headers(1))
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(len(listing.json()["items"]), 1)
        row = listing.json()["items"][0]
        self.assertEqual(row["messageCount"], 2)
        cid = row["id"]
        messages = await self.http[1].get(f"/api/v1/account-conversations/{cid}/messages", headers=self.headers(1))
        self.assertEqual([x["text"] for x in messages.json()["items"]],
                         ["Private Alice question", "Private Alice answer"])
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(AccountConversation)), 1)
            self.assertEqual(await session.scalar(select(func.count()).select_from(AccountConversationMessage)), 2)
            device_auth.activate(await session.get(models.Client, "poll-device-0"), await session.get(models.User, "bob"))
            await session.commit()
        stale = await self.http[1].post("/api/v1/account-conversations/sync", headers=self.headers(), json=self.checkpoint())
        self.assertEqual(stale.status_code, 401)
        denied = await self.http[0].get(f"/api/v1/account-conversations/{cid}/messages", headers=self.bob_headers)
        self.assertEqual(denied.status_code, 404)
        bob_list = await self.http[1].get("/api/v1/account-conversations", headers=self.bob_headers)
        self.assertEqual(bob_list.json()["items"], [])
        self.assertEqual((await self.http[1].get(f"/api/v1/account-conversations/{cid}/messages",
                                               headers=self.headers(1))).status_code, 200)

    async def test_usage_replay_is_idempotent_and_quota_exhaustion_is_immediate(self):
        async with self.sessions() as session:
            session.add(models.AppSetting(key=client_access.USER_QUOTA_PREFIX + "alice",
                                          value=json.dumps({"mode": "limited", "limit": 10})))
            await session.commit()
        await self.inbox()
        self.assertEqual((await self.http[0].get("/test/ai-admission", headers=self.headers())).status_code, 200)
        body = {"sourceId": "traffic-usage", "sourceType": "chat", "provider": "fixture-provider",
                "model": "fixture-chat", "usage": {"totalTokens": 12}}
        for node in (0, 1):
            response = await self.http[node].post("/api/v1/usage/events", headers=self.headers(), json=body)
            self.assertEqual(response.status_code, 200, response.text[:300])
            self.assertTrue(response.json()["quota"]["exceeded"])
            self.assertEqual(response.json()["quota"]["used"], 12)
        async with self.sessions() as session:
            rows = list((await session.scalars(select(models.AIUsageEvent))).all())
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0].billing_user_id, rows[0].total_tokens), ("alice", 12))
        self.assertEqual((await self.http[1].get("/test/ai-admission", headers=self.headers())).status_code, 403)
        self.assertEqual((await self.inbox(node=1)).status_code, 200)
        body["usage"]["totalTokens"] = 13
        final = await self.http[1].post("/api/v1/usage/events", headers=self.headers(), json=body)
        self.assertEqual(final.status_code, 200)
        self.assertEqual(final.json()["quota"]["used"], 13)

    async def test_model_configuration_changes_are_visible_with_warm_identity_and_secrets_are_masked(self):
        await self.inbox()
        before = await self.http[0].get("/api/v1/my-models", headers=self.headers())
        self.assertEqual(before.status_code, 200, before.text[:300])
        self.assertIn("fixture-chat", [m["name"] for m in before.json()["usable"]])
        secret = "isolated-replacement-model-credential"
        changed = await self.http[1].put("/api/v1/my-models", headers=self.headers(), json={
            "expectedRevision": before.json()["revision"], "keys": {"fixture-provider": secret},
            "models": [{"providerId": "fixture-provider", "name": "fixture-alternate", "label": "Alternate"}]})
        self.assertEqual(changed.status_code, 200, changed.text[:300])
        after = await self.http[0].get("/api/v1/my-models", headers=self.headers())
        self.assertEqual(after.status_code, 200)
        self.assertIn("fixture-alternate", [m["name"] for m in after.json()["myModels"]])
        self.assertNotEqual(before.json()["revision"], after.json()["revision"])
        for response in (before, changed, after):
            self.assertNotIn("isolated-never-used", response.text)
            self.assertNotIn(secret, response.text)
        self.probe.assert_not_called()

    async def test_cloud_execution_detail_returns_real_events_and_receipts_only_to_owner(self):
        handoff = "11111111-1111-4111-8111-111111111111"
        async with self.sessions() as session:
            session.add_all([
                models.Task(id="traffic-cloud-task", title="Cloud fixture", owner_client_id="poll-device-0",
                    owner_user_id="alice", origin="cloud-conversation"),
                ConversationHandoff(id=handoff, owner_client_id="poll-device-0", owner_user_id="alice",
                    transfer_id=handoff, task_id="traffic-cloud-task", phase="committed",
                    options={"agentId": "pi", "assigneeId": "runner:cloud:pi", "targetSnapshot": {"runnerId": "cloud"}},
                    source={"entryKind": "cloud", "sessionId": "traffic-source", "adapterId": "pi"},
                    receipt={"ref": "traffic-cloud-ref", "runnerId": "cloud"}),
                models.TaskEvent(task_id="traffic-cloud-task", kind=ai_exec.EV_DISPATCHED,
                                 detail={"ref": "traffic-cloud-ref", "runnerId": "cloud"}),
                am.ExecutionSession(id="traffic-execution", task_id="traffic-cloud-task", ref="traffic-cloud-ref",
                                    runner_id="cloud", state="done", seq=1),
                am.ExecutionEvent(session_id="traffic-execution", seq=1, kind="say", text="Persisted cloud answer"),
                ConversationMessageReceipt(id="traffic-receipt", task_id="traffic-cloud-task", owner_client_id="poll-device-0",
                    message_id="cloud-message", content_hash="fixture-hash", phase="queued",
                    payload={"text": "private payload", "secret": "credential-never-returned"},
                    receipt={"queued": True, "delivery": "queued"}),
            ])
            await session.commit()
        await self.inbox(index=1)
        response = await self.http[1].get(f"/api/v1/cloud-execution-sync/{handoff}", headers=self.headers(1))
        self.assertEqual(response.status_code, 200, response.text[:300])
        self.assertEqual(response.json()["page"]["items"][0]["text"], "Persisted cloud answer")
        self.assertEqual(response.json()["messages"][0]["messageId"], "cloud-message")
        self.assertNotIn("credential-never-returned", response.text)
        denied = await self.http[0].get(f"/api/v1/cloud-execution-sync/{handoff}", headers=self.bob_headers)
        self.assertEqual(denied.status_code, 404)
        directory = await self.http[1].get("/api/v1/cloud-execution-sync", headers=self.bob_headers)
        self.assertEqual(directory.json()["items"], [])

    async def test_remote_screen_lists_real_grants_by_owner_and_source_device(self):
        await self.seed_screens()
        await self.inbox()
        for node in (0, 1):
            response = await self.http[node].get("/api/v1/remote-screen/requests", headers=self.headers())
            self.assertEqual(response.status_code, 200)
            self.assertEqual([x["id"] for x in response.json()["items"]], ["alice-screen"])
        sibling = await self.http[1].get("/api/v1/remote-screen/requests", headers=self.headers(2))
        self.assertEqual(sibling.json()["items"], [])
        bob = await self.http[1].get("/api/v1/remote-screen/requests", headers=self.bob_headers)
        self.assertEqual([x["id"] for x in bob.json()["items"]], ["bob-screen"])
        denied = await self.http[0].get("/api/v1/remote-screen/requests/alice-screen", headers=self.bob_headers)
        self.assertEqual(denied.status_code, 404)

    async def test_team_message_list_has_account_isolation_and_live_revision_changes(self):
        await self.seed_messages()
        await self.inbox()
        response = await self.http[1].get("/api/v1/team/messages", headers=self.headers())
        self.assertEqual(response.status_code, 200)
        self.assertEqual([x["id"] for x in response.json()["items"]], ["message-to-alice"])
        revision = response.json()["revision"]
        unchanged = await self.http[0].get("/api/v1/team/messages", headers=self.headers(), params={"ifRevision": revision})
        self.assertTrue(unchanged.json()["notModified"])
        async with self.sessions() as session:
            session.add(models.MateMessage(id="message-to-alice-2", sender_id="bob", recipient_id="alice",
                client_message_id="to-alice-2", text="A fresh notification"))
            await session.commit()
        fresh = await self.http[1].get("/api/v1/team/messages", headers=self.headers(), params={"ifRevision": revision})
        self.assertNotEqual(fresh.json()["revision"], revision)
        self.assertEqual({x["id"] for x in fresh.json()["items"]}, {"message-to-alice", "message-to-alice-2"})
        bob = await self.http[0].get("/api/v1/team/messages", headers=self.bob_headers)
        self.assertEqual([x["id"] for x in bob.json()["items"]], ["message-to-bob"])

    async def test_scaled_internal_traffic_mix_with_business_rows_and_real_authentication(self):
        await self.seed_screens()
        await self.seed_messages()
        await self.sync_conversation()
        await self.inbox()
        weights = {"inbox": 69725, "screen": 11184, "relay": 6264, "enroll": 4002,
                   "team": 3302, "accountsync": 1889, "usage": 703, "my_models": 645}
        counts = {name: max(1, round(count / 1000)) for name, count in weights.items()}
        requests = {
            "inbox": ("POST", "/api/v1/automation-conversations/inbox", {}),
            "screen": ("GET", "/api/v1/remote-screen/requests", {}),
            "relay": ("POST", "/api/v1/personal-conversation-relay/poll", {"json": {}}),
            "enroll": ("POST", "/api/v1/clients/enroll", {"headers": {"X-Device-Key": self.device_key},
                "json": {"device": "poll-device-0", "version": "1.13.12", "platform": "win32"}}),
            "team": ("GET", "/api/v1/team/messages", {}),
            "accountsync": ("POST", "/api/v1/account-conversations/sync", {"json": self.checkpoint()}),
            "usage": ("POST", "/api/v1/usage/events", {"json": {"sourceId": "mix-usage", "usage": {"totalTokens": 2}}}),
            "my_models": ("GET", "/api/v1/my-models", {}),
        }
        performed = 0
        sql_profile = {name: {"selects": 0, "fullClientReads": 0, "fullUserReads": 0} for name in counts}
        for tick in range(max(counts.values())):
            for name, count in counts.items():
                if tick >= count:
                    continue
                method, path, extra = requests[name]
                options = {"headers": self.headers(), **extra}
                start = len(self.sql)
                response = await self.http[performed % 2].request(method, path, **options)
                self.assertEqual(response.status_code, 200, (name, response.text[:300]))
                reads = [sql for sql in self.sql[start:] if sql.lstrip().startswith("select")]
                sql_profile[name]["selects"] += len(reads)
                sql_profile[name]["fullClientReads"] += sum("client.model_keys" in sql for sql in reads)
                sql_profile[name]["fullUserReads"] += sum("app_user.password_hash" in sql for sql in reads)
                performed += 1
        self.assertEqual(performed, sum(counts.values()))
        for name in ("inbox", "screen", "team"):
            self.assertEqual(sql_profile[name]["fullClientReads"], 0, name)
            self.assertEqual(sql_profile[name]["fullUserReads"], 0, name)
        self.probe.assert_not_called()
        print("ISOLATED_AUTH_TRAFFIC " + json.dumps({"sourceWindowMinutes": 10,
            "scaleDivisor": 1000, "requests": performed, "routes": counts,
            "nodes": 2, "realTimeReplay": False, "sql": sql_profile}), flush=True)
