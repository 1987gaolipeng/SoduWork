"""Native inbox push: real isolated transactions and compatibility negotiation."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-inbox-push-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-inbox-push-tests")

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models
from app.services import schedule_conversations as conversations, native_discovery as discovery
from app.services import automation_inbox_events as events


class InboxCommitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        events.start()
        self.directory = tempfile.TemporaryDirectory(prefix="inbox-push-")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(self.directory.name) / "test.db"))
        async with self.engine.begin() as connection:
            for table in (models.Client.__table__, models.AiSchedule.__table__, models.AiScheduleRun.__table__):
                await connection.run_sync(table.create)
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.session = self.factory()
        self.client = models.Client(id="pc", user_ref="alice", config={"automationConversationV1": 1})
        self.plan = models.AiSchedule(id="plan", owner_client_id="pc", owner_user_id="alice",
            title="Authorized schedule", note="Original instruction", assignee_id="local:pi")
        self.run = models.AiScheduleRun(id="run", schedule_id="plan", owner_client_id="pc",
            owner_user_id="alice", state="waiting", receipt={})
        self.session.add(self.client); await self.session.flush()
        self.session.add(self.plan); await self.session.flush()
        self.session.add(self.run)
        await self.commit()
        self.wake = AsyncMock()
        self.patcher = patch.object(discovery, "wake", self.wake)
        self.patcher.start()

    async def asyncTearDown(self):
        await events.stop()
        self.patcher.stop()
        await self.session.close()
        await self.engine.dispose()
        self.directory.cleanup()

    async def commit(self):
        await self.session.commit()
        await events.flush_for_test()

    async def prepare(self):
        return await conversations.prepare(self.session, self.plan, self.client, None, "run", "pi", {})

    async def test_preparation_is_visible_to_another_node_before_wake_and_is_hint_only(self):
        observations = []
        async def observed(device, owner, topic):
            async with self.factory() as other:
                row = await other.get(models.AiScheduleRun, "run")
                observations.append((device, owner, topic, row.receipt["executionMode"]))
        self.wake.side_effect = observed
        await self.prepare()
        self.wake.assert_not_awaited()
        await self.commit()
        self.assertEqual(observations, [("pc", "alice", "automation-inbox", conversations.PROTOCOL)])
        self.assertEqual(await conversations.inbox(self.session, self.client), [{"id": "run", "state": "waiting"}])
        self.assertEqual(self.wake.await_count, 1, "a read cannot wake itself")

    async def test_claim_and_running_lease_refresh_do_not_form_push_poll_feedback(self):
        await self.prepare(); await self.commit()
        await conversations.claim(self.session, self.client, "run", "worker")
        self.assertEqual(self.wake.await_count, 1)
        body = {"instanceId": "worker", "conversationId": "ordinary-chat", "state": "running"}
        await conversations.acknowledge(self.session, self.client, "run", body)
        await events.flush_for_test()
        self.assertEqual(self.wake.await_count, 2)
        for _ in range(3):
            await conversations.claim(self.session, self.client, "run", "worker")
            await conversations.acknowledge(self.session, self.client, "run", body)
        self.assertEqual(self.wake.await_count, 2)
        await conversations.acknowledge(self.session, self.client, "run", {**body, "state": "succeeded"})
        await events.flush_for_test()
        self.assertEqual(self.wake.await_count, 3)
        self.assertEqual(await conversations.inbox(self.session, self.client), [])

    async def test_rollback_and_later_transaction_cannot_publish_aborted_preparation(self):
        await self.prepare(); await self.session.rollback()
        self.wake.assert_not_awaited()
        await self.commit()
        self.wake.assert_not_awaited()
        self.run = await self.session.get(models.AiScheduleRun, "run")
        self.run.receipt = {"executionMode": conversations.PROTOCOL}
        await self.commit()
        self.wake.assert_awaited_once_with("pc", "alice", "automation-inbox")

    async def test_nested_commit_waits_for_outer_commit_and_outer_rollback_discards_it(self):
        nested = await self.session.begin_nested()
        await self.prepare(); await nested.commit()
        self.wake.assert_not_awaited()
        await self.session.rollback()
        self.wake.assert_not_awaited()
        async with self.session.begin_nested():
            self.run = await self.session.get(models.AiScheduleRun, "run")
            self.run.receipt = {"executionMode": conversations.PROTOCOL}
            self.run.state = "running"
        self.wake.assert_not_awaited()
        await self.commit()
        self.wake.assert_awaited_once_with("pc", "alice", "automation-inbox")

    async def test_savepoint_rollback_preserves_earlier_outer_changes_only(self):
        await self.prepare()
        nested = await self.session.begin_nested()
        self.run.owner_client_id = "other-device"
        self.run.owner_user_id = "bob"
        await self.session.flush()
        await nested.rollback()
        await self.commit()
        self.wake.assert_awaited_once_with("pc", "alice", "automation-inbox")

    async def test_failed_flush_requires_rollback_and_drops_pending_hints(self):
        await self.prepare()
        self.session.add(models.AiScheduleRun(id="duplicate-key", idempotency_key=self.run.idempotency_key,
            schedule_id="plan", owner_client_id="pc",
            owner_user_id="alice", state="running", receipt={"executionMode": conversations.PROTOCOL}))
        with self.assertRaises(IntegrityError):
            await self.session.flush()
        await self.session.rollback()
        await self.commit()
        self.wake.assert_not_awaited()

    async def test_scope_transfer_and_removal_notify_old_and_new_inboxes_once(self):
        await self.prepare(); await self.commit(); self.wake.reset_mock()
        self.run.owner_client_id = "other-pc"; self.run.owner_user_id = "bob"
        await self.commit()
        self.assertEqual({call.args for call in self.wake.await_args_list}, {
            ("pc", "alice", "automation-inbox"), ("other-pc", "bob", "automation-inbox")})
        self.wake.reset_mock()
        await self.session.delete(self.run); await self.commit()
        self.wake.assert_awaited_once_with("other-pc", "bob", "automation-inbox")

    async def test_publish_failure_does_not_report_a_committed_run_as_rolled_back(self):
        self.wake.side_effect = RuntimeError("isolated broker failure")
        await self.prepare()
        with self.assertLogs("uvicorn.error", "WARNING"):
            await self.commit()
        async with self.factory() as other:
            row = await other.get(models.AiScheduleRun, "run")
            self.assertEqual(row.receipt["executionMode"], conversations.PROTOCOL)

    async def test_multiple_runs_coalesce_and_cloud_or_unprepared_rows_do_not_publish(self):
        await self.prepare()
        for index in range(5):
            self.session.add(models.AiScheduleRun(id=f"other-{index}", schedule_id="plan", owner_client_id="pc",
                owner_user_id="alice", state="starting", receipt={"executionMode": conversations.PROTOCOL}))
        await self.commit()
        self.wake.assert_awaited_once_with("pc", "alice", "automation-inbox")
        self.wake.reset_mock()
        self.session.add(models.AiScheduleRun(id="cloud", schedule_id="plan", owner_client_id="pc",
            owner_user_id="alice", state="running", receipt={"executionMode": "soduwork.cloud-automation/v1"}))
        await self.commit()
        self.wake.assert_not_awaited()

    async def test_commit_releases_the_request_before_slow_notification_and_queue_is_bounded(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def slow(*_):
            entered.set()
            await release.wait()
        self.wake.side_effect = slow
        await self.prepare()
        await asyncio.wait_for(self.session.commit(), timeout=1)
        self.assertFalse(entered.is_set(), "postcommit delivery is debounced outside the committing request")
        await asyncio.wait_for(entered.wait(), timeout=1)
        async with self.factory() as other:
            self.assertEqual((await other.get(models.AiScheduleRun, "run")).receipt["executionMode"], conversations.PROTOCOL)
        for index in range(5000):
            events._enqueue({(f"device-{index}", "alice")})
        self.assertLessEqual(len(events._pending), 2048)
        # Shutdown cancels a slow broker within its own bounded budget.
        await asyncio.wait_for(events.stop(), timeout=3)
        self.assertIsNone(events._worker)
        self.assertEqual(events._pending, set())

    async def test_cross_transaction_bursts_coalesce_without_delaying_database_commits(self):
        await self.prepare(); await self.session.commit()
        self.run.state = "running"; await self.session.commit()
        self.run.state = "succeeded"; await self.session.commit()
        self.wake.assert_not_awaited()
        await events.flush_for_test()
        self.wake.assert_awaited_once_with("pc", "alice", "automation-inbox")


class NegotiationTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_and_extended_frames_have_separate_allowlists(self):
        def frame(protocol, topics): return json.dumps({"t": "native-discovery", "protocol": protocol, "topics": topics})
        self.assertEqual(discovery.heartbeat_topics(frame(1, ["remote-screen", "personal-relay"])),
                         ["remote-screen", "personal-relay"])
        self.assertIsNone(discovery.heartbeat_topics(frame(1, ["automation-inbox"])))
        self.assertEqual(discovery.heartbeat_topics(frame(2, ["automation-inbox"])), ["automation-inbox"])
        self.assertIsNone(discovery.heartbeat_topics(frame(2, ["unknown"])))
        touch = AsyncMock()
        with patch.object(discovery.presence, "touch", touch):
            self.assertTrue(await discovery.heartbeat(frame(2, ["automation-inbox"]), "pc", "alice"))
        touch.assert_not_awaited()

    async def test_mixed_nodes_missing_state_and_redis_failure_do_not_confirm_new_push(self):
        redis = SimpleNamespace(zrangebyscore=AsyncMock(return_value=[b"new", b"old"]),
            mget=AsyncMock(return_value=[{"nativeDiscoveryTopics": list(discovery.EXTENDED_TOPICS)}, {}]))
        bus = SimpleNamespace(enabled=True, healthy=True, redis=redis,
            settings=SimpleNamespace(cluster_lease_seconds=30), key=lambda kind, key="": f"{kind}:{key}",
            codec=SimpleNamespace(decode=lambda value: value))
        with patch.object(discovery, "bus", bus):
            self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), [])
            redis.mget.return_value = [{"nativeDiscoveryTopics": ["automation-inbox"]}] * 2
            self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), ["automation-inbox"])
            redis.mget.return_value = [{"nativeDiscoveryTopics": ["automation-inbox"]}, None]
            self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), [])
            redis.mget.side_effect = OSError("isolated redis outage")
            self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), [])
            bus.healthy = False
            self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), [])

    async def test_v1_and_v2_heartbeats_do_not_rate_limit_each_other(self):
        from fastapi import WebSocketDisconnect
        from app.api import ws as api
        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *_): pass
        class Socket:
            def __init__(self):
                self.sent = []
                self.frames = iter([json.dumps({"t": "native-discovery", "protocol": version, "topics": topics})
                    for version, topics in [(1, ["personal-relay"]), (2, ["automation-inbox"]),
                                            (1, ["personal-relay"]), (2, ["automation-inbox"])]])
            async def receive_text(self):
                try: return next(self.frames)
                except StopIteration: raise WebSocketDisconnect()
            async def send_json(self, value): self.sent.append(value)
            async def close(self, **_): pass
        socket = Socket()
        hub = SimpleNamespace(connect=AsyncMock(return_value=True), disconnect=AsyncMock())
        device = SimpleNamespace(user_ref="alice", auth_version=7, app_version="test")
        with patch.object(api, "SessionLocal", Session), patch.object(api, "hub", hub), \
             patch.object(api.device_auth, "client_from_transport", AsyncMock(return_value=device)), \
             patch("app.services.update_nudges.latest_client_release", AsyncMock(return_value=None)), \
             patch("app.services.update_nudges.nudge_stale_client", AsyncMock()), \
             patch.object(discovery, "confirmed_topics", AsyncMock(return_value=["automation-inbox"])), \
             patch.object(api, "time", SimpleNamespace(monotonic=lambda: 100)):
            await api.ws(socket, "pc", secret="", device_session="isolated-session")
        self.assertEqual(socket.sent[1:], [
            {"type": "native-discovery-ready", "protocol": 1},
            {"type": "native-discovery-ready", "protocol": 2, "topics": ["automation-inbox"]}])


if __name__ == "__main__": unittest.main()
