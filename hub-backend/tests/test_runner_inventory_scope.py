"""Inventory identity stays separate across profiles and physical environments."""
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-runner-inventory-fixture")

from app.services.runner_inventory_scope import scope_for


class RunnerInventoryScopeTests(unittest.TestCase):
    def setUp(self):
        self.client = SimpleNamespace(id="source-checkout", user_ref="owner")

    def test_same_hostname_different_client_is_not_the_current_instance(self):
        installed = {"runnerId": "installed-runner", "clientId": "installed-profile",
                     "ownerUserId": "", "embedded": True, "host": "DESKTOP-ONE"}
        current = {**installed, "runnerId": "source-runner", "clientId": self.client.id}
        self.assertEqual(scope_for(self.client, current), "current-instance")
        self.assertEqual(scope_for(self.client, installed), "")

    def test_personal_cloud_keeps_its_identity_even_with_a_local_display_name(self):
        cloud = {"runnerId": "linux-cloud", "clientId": "", "ownerUserId": "owner",
                 "embedded": False, "label": "我的电脑", "os": "Linux 6.8"}
        self.assertEqual(scope_for(self.client, cloud), "personal-cloud")
        self.assertEqual(scope_for(self.client, {**cloud, "ownerUserId": "another-owner"}), "")

    def test_bound_standalone_runner_does_not_become_current(self):
        runner = SimpleNamespace(client_id=self.client.id, owner_user_id="", tags=[], host="DESKTOP-ONE")
        self.assertEqual(scope_for(self.client, runner), "bound-runner")
        runner.tags = ["soduwork-client"]
        self.assertEqual(scope_for(self.client, runner), "current-instance")

    def test_shared_or_unbound_identity_never_matches_empty_values(self):
        anonymous = SimpleNamespace(id="", user_ref="")
        self.assertEqual(scope_for(anonymous, {"embedded": True}), "")
        self.assertEqual(scope_for(self.client, {"clientId": "", "ownerUserId": ""}), "")

    def test_owner_claim_cannot_override_a_different_device_binding(self):
        foreign = {"clientId": "different-profile", "ownerUserId": "owner", "embedded": True}
        self.assertEqual(scope_for(self.client, foreign), "")
        self.assertEqual(scope_for(self.client, {**foreign, "clientId": self.client.id,
                                               "ownerUserId": "another-owner"}), "")


class InventoryRouteTests(unittest.IsolatedAsyncioTestCase):
    def runner(self, *, client_id="source", owner_user_id="owner", embedded=True):
        from app.services.runner_hub import CLIENT_TAG
        return SimpleNamespace(id="target", client_id=client_id, owner_user_id=owner_user_id,
                               tags=[CLIENT_TAG] if embedded else [], dispatch_mode="draining",
                               call=AsyncMock(return_value={"ok": True, "data": {}}))

    async def invoke(self, routes, operation, client, session):
        if operation == "mode":
            return await routes.runner_mode("target", {"mode": "draining"}, client, session)
        if operation == "probe":
            return await routes.runner_probe("target", client, session)
        if operation == "component-install":
            return await routes.runner_component_install("target", "office", client, session)
        return await routes.runner_component_job("target", "fixture-job", client, session)

    async def test_client_operations_reject_hidden_profiles_and_owners_before_side_effects(self):
        from app.api import runner_ws
        from fastapi import HTTPException
        client = SimpleNamespace(id="source", user_ref="owner")
        rows = [self.runner(client_id="installed-profile"),
                self.runner(owner_user_id="previous-owner"),
                self.runner(client_id="", owner_user_id="", embedded=False), None]
        for row in rows:
            for operation in ("mode", "probe", "component-install", "component-job"):
                with self.subTest(row=row, operation=operation):
                    session = SimpleNamespace(get=AsyncMock(return_value=row), commit=AsyncMock())
                    live = self.runner()
                    with patch.object(runner_ws.runner_hub, "get", return_value=live), \
                            patch.object(runner_ws.runner_registry, "set_mode", AsyncMock()) as change:
                        with self.assertRaises(HTTPException) as error:
                            await self.invoke(runner_ws, operation, client, session)
                    self.assertEqual(error.exception.status_code, 404)
                    live.call.assert_not_awaited()
                    change.assert_not_awaited()
                    session.commit.assert_not_awaited()

    async def test_live_identity_mismatch_cannot_override_the_persisted_scope(self):
        from app.api import runner_ws
        from fastapi import HTTPException
        client = SimpleNamespace(id="source", user_ref="owner")
        for operation in ("mode", "probe", "component-install", "component-job"):
            with self.subTest(operation=operation):
                row = self.runner()
                live = self.runner(client_id="installed-profile")
                session = SimpleNamespace(get=AsyncMock(return_value=row), commit=AsyncMock())
                with patch.object(runner_ws.runner_hub, "get", return_value=live), \
                        patch.object(runner_ws.runner_registry, "set_mode", AsyncMock()) as change:
                    with self.assertRaises(HTTPException) as error:
                        await self.invoke(runner_ws, operation, client, session)
                self.assertEqual(error.exception.status_code, 404)
                live.call.assert_not_awaited()
                change.assert_not_awaited()
                session.commit.assert_not_awaited()

    async def test_superuser_desktop_does_not_gain_other_instance_control(self):
        from app.api import runner_ws
        from fastapi import HTTPException
        client = SimpleNamespace(id="source", user_ref="owner")
        row = self.runner(client_id="installed-profile")
        session = SimpleNamespace(get=AsyncMock(side_effect=[row, SimpleNamespace(is_super=True)]))
        with self.assertRaises(HTTPException) as error:
            await runner_ws._client_runner(session, client, "target")
        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(session.get.await_count, 1)

    async def test_visible_nodes_allow_probe_and_mode_without_expanding_component_install(self):
        from app.api import runner_ws
        from app.services import cloud_environments
        from fastapi import HTTPException
        client = SimpleNamespace(id="source", user_ref="owner")
        for row in (self.runner(), self.runner(embedded=False),
                    self.runner(client_id="", embedded=False)):
            with self.subTest(scope=scope_for(client, row)):
                session = SimpleNamespace(get=AsyncMock(return_value=row), commit=AsyncMock())
                with patch.object(runner_ws.runner_hub, "get", return_value=row), \
                        patch.object(runner_ws.runner_registry, "set_mode", AsyncMock(return_value=row)) as change, \
                        patch.object(cloud_environments, "update", AsyncMock(return_value={
                            "ok": True, "environment": {"mode": "draining"}})) as cloud_change:
                    changed = await self.invoke(runner_ws, "mode", client, session)
                    self.assertEqual(changed["mode"], "draining")
                    if scope_for(client, row) == "personal-cloud":
                        cloud_change.assert_awaited_once_with(session, client, "target", {"mode": "draining"})
                        change.assert_not_awaited()
                        session.commit.assert_not_awaited()
                    else:
                        change.assert_awaited_once_with(session, "target", "draining")
                        session.commit.assert_awaited_once()
                        cloud_change.assert_not_awaited()
                    self.assertTrue((await self.invoke(runner_ws, "probe", client, session))["ok"])
                    row.call.assert_awaited_once_with("runner.probe", {}, timeout=12)
                    row.call.reset_mock()
                    if scope_for(client, row) == "current-instance":
                        for operation in ("component-install", "component-job"):
                            self.assertTrue((await self.invoke(runner_ws, operation, client, session))["ok"])
                        self.assertEqual(row.call.await_count, 2)
                    else:
                        for operation in ("component-install", "component-job"):
                            with self.assertRaises(HTTPException) as error:
                                await self.invoke(runner_ws, operation, client, session)
                            self.assertEqual(error.exception.status_code, 403)
                        row.call.assert_not_awaited()

    async def test_personal_cloud_mode_retains_locked_owner_and_admin_state_checks(self):
        from app.api import runner_ws
        from app.services import cloud_environments
        from fastapi import HTTPException
        client = SimpleNamespace(id="source", user_ref="owner")
        row = self.runner(client_id="", embedded=False)
        for state in ("disabled", "pending_setup", "retired", "reassigned"):
            for mode in ("accepting", "draining"):
                with self.subTest(state=state, mode=mode):
                    row.management_state = state
                    session = SimpleNamespace(get=AsyncMock(return_value=row), commit=AsyncMock())
                    with patch.object(runner_ws.runner_hub, "get", return_value=row), \
                            patch.object(cloud_environments, "_user", AsyncMock(return_value=SimpleNamespace(id="owner"))), \
                            patch.object(cloud_environments, "_own_row", AsyncMock(
                                return_value=None if state == "reassigned" else row)) as locked_owner, \
                            patch.object(runner_ws.runner_registry, "set_mode", AsyncMock()) as change:
                        with self.assertRaises(HTTPException) as error:
                            await runner_ws.runner_mode("target", {"mode": mode}, client, session)
                    self.assertEqual(error.exception.status_code, 404 if state == "reassigned" else 409)
                    locked_owner.assert_awaited_once_with(session, "owner", "target", lock=True)
                    change.assert_not_awaited()
                    session.commit.assert_not_awaited()

    async def test_visible_offline_node_keeps_offline_diagnostics(self):
        from app.api import runner_ws
        from fastapi import HTTPException
        client = SimpleNamespace(id="source", user_ref="owner")
        session = SimpleNamespace(get=AsyncMock(return_value=self.runner()))
        with patch.object(runner_ws.runner_hub, "get", return_value=None):
            result = await self.invoke(runner_ws, "probe", client, session)
            self.assertFalse(result["ok"])
            self.assertEqual(result["runnerId"], "target")
            with self.assertRaises(HTTPException) as error:
                await self.invoke(runner_ws, "component-install", client, session)
        self.assertEqual(error.exception.status_code, 409)

    async def test_list_preserves_same_host_instances_and_excludes_another_profile(self):
        from app.api import runner_ws
        client = SimpleNamespace(id="source", user_ref="owner")
        base = {"host": "ONE-HOST", "machineKey": "host:ONE-HOST", "online": True,
                "embedded": True, "clientId": "source", "ownerUserId": ""}
        rows = [{**base, "runnerId": "source-a"}, {**base, "runnerId": "source-b"},
                {**base, "runnerId": "installed", "clientId": "installed-profile", "ownerUserId": "owner"},
                {**base, "runnerId": "cloud", "clientId": "", "ownerUserId": "owner", "embedded": False}]
        with patch.object(runner_ws.runner_registry, "list_nodes", AsyncMock(return_value=rows)):
            result = await runner_ws.list_runners(client, object())
        self.assertEqual([r["runnerId"] for r in result["runners"]], ["source-a", "source-b", "cloud"])
        self.assertEqual([r["scope"] for r in result["runners"]],
                         ["current-instance", "current-instance", "personal-cloud"])

    async def test_missing_target_cannot_fall_back_when_only_personal_cloud_is_online(self):
        from app.api import agents
        from fastapi import HTTPException
        client = SimpleNamespace(id="source", user_ref="owner")
        cloud = SimpleNamespace(id="cloud", client_id="", owner_user_id="owner", tags=[])
        with patch.object(agents.runner_hub, "for_client", return_value=None), \
                patch.object(agents.runner_hub, "online", return_value=[cloud]), \
                patch.object(agents.bus, "enabled", False):
            with self.assertRaises(HTTPException) as error:
                agents._pick_runner(client, "")
        self.assertEqual(error.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
