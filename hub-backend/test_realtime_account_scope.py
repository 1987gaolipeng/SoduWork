"""Account-scoped events must not cross a same-device reconnect."""
import os
os.environ.setdefault("AUTH_SECRET", "isolated-realtime-account-scope")
os.environ.setdefault("ADMIN_PASS", "isolated-realtime-admin")
os.environ["CLUSTER_REDIS_URL"] = ""
import unittest
from unittest.mock import AsyncMock, patch
from app.realtime import Hub
from app.services import cluster_bus, cluster_runtime, task_access, task_notifications


class Socket:
    def __init__(self):
        self.messages = []

    async def accept(self):
        pass

    async def send_json(self, message):
        self.messages.append(message)


class RealtimeAccountScopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_durable_fanout_retains_account_after_projection_and_reconnect(self):
        hub, old, new = Hub(), Socket(), Socket()
        await hub.connect("shared-device", old, user_id="alice")
        prepared = [("shared-device", {"type": "task.updated", "task": {"id": "private"}}, "alice")]
        await hub.disconnect("shared-device", old)
        await hub.connect("shared-device", new, user_id="bob")
        with patch.object(task_access, "hub", hub), patch.object(cluster_bus.bus, "enabled", False):
            await task_access.publish_events(prepared, publish=task_notifications.publish_reliably)
            self.assertEqual(new.messages, [])
            await hub.connect("shared-device", old, user_id="alice")
            await task_access.publish_events(prepared, publish=task_notifications.publish_reliably)
        self.assertEqual(old.messages, [prepared[0][1]])
        self.assertEqual(new.messages, [])

    async def test_durable_cluster_transport_preserves_account_and_strict_failure(self):
        event = {"type": "task.deleted", "id": "private"}
        with patch.object(cluster_bus.bus, "enabled", True), \
             patch.object(cluster_bus.bus, "broadcast", AsyncMock()) as broadcast, \
             patch.object(task_access.hub, "publish", AsyncMock()) as local:
            await task_notifications.publish_reliably("device", event, user_id="alice")
            broadcast.assert_awaited_once_with({"kind": "publish", "device": "device",
                "event": event, "userId": "alice"}, strict=True)
            local.assert_awaited_once_with("device", event, _local=True, user_id="alice")
            broadcast.side_effect = RuntimeError("remote inbox unavailable")
            local.reset_mock()
            with self.assertRaisesRegex(RuntimeError, "remote inbox"):
                await task_notifications.publish_reliably("device", event, user_id="alice")
            local.assert_not_awaited()

    async def test_old_account_event_is_not_delivered_to_new_account_on_same_device(self):
        hub, old, new = Hub(), Socket(), Socket()
        await hub.connect("shared-device", old, user_id="alice")
        await hub.disconnect("shared-device", old)
        await hub.connect("shared-device", new, user_id="bob")
        event = {"type": "task.updated", "task": {"id": "alice-private"}}
        await hub.publish("shared-device", event, user_id="alice")
        self.assertEqual(new.messages, [])
        await hub.publish("shared-device", {"type": "task.updated", "task": {"id": "bob-own"}}, user_id="bob")
        self.assertEqual(new.messages[0]["task"]["id"], "bob-own")
        await hub.disconnect("shared-device", new)
        self.assertEqual(hub._users, {})

    async def test_cluster_transport_keeps_account_fence_outside_business_payload(self):
        hub = Hub()
        class Bus:
            enabled = True
            healthy = True
            broadcast = AsyncMock()
        bus = Bus()
        event = {"type": "task.deleted", "id": "private"}
        with patch.object(cluster_bus, "bus", bus):
            await hub.publish("device", event, user_id="alice")
        envelope = bus.broadcast.await_args.args[0]
        self.assertEqual(envelope["userId"], "alice")
        self.assertEqual(envelope["event"], event)
        with patch("app.realtime.hub", hub), patch.object(hub, "publish", AsyncMock()) as publish:
            await cluster_runtime.on_event(envelope)
        publish.assert_awaited_once_with("device", event, _local=True, user_id="alice")


if __name__ == "__main__":
    unittest.main()
