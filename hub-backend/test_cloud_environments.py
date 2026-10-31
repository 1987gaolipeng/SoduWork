"""Device-authenticated personal cloud ownership and pinned handoff routing."""
import hashlib
import asyncio
import io
import json
import unittest
import threading
from types import SimpleNamespace
import zipfile
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException

from test_handoff_target_diagnostics import TargetDiagnosticsTests as _Base, WORK
from app import db, models
from app.api import cloud_environments as api
from app.automation_models import ExecutionSession, RunnerNode
from app.conversation_handoff_models import ConversationHandoff
from app.services import ai_exec, ai_remote, conversation_handoffs, runner_hub, runner_registry, storage
from sqlalchemy import select


class CloudEnvironmentsTests(_Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.app.include_router(api.router)
        storage._LOCAL_DIR = str(WORK / "isolated-uploads")

    async def manager(self):
        async with db.SessionLocal() as session:
            role = models.Role(id=self.prefix + "-role", name="Cloud operator", permissions=["runner.manage"])
            session.add(role)
            user = await session.get(models.User, self.user_id)
            user.role_id = role.id
            await session.commit()

    async def test_cloud_crud_permissions_credentials_and_delete_guards(self):
        endpoint = "/api/v1/cloud-environments"
        initial = await self.http.get(endpoint)
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertEqual(initial.json()["ownership"], "personal")
        self.assertEqual(initial.json()["permissions"],
                         {"canCreate": True, "limit": 1, "canManage": False})
        self.assertEqual(initial.json()["organizations"], [])
        body = {"name": "My cloud one", "hub": "https://soduwork.example.test/hub"}
        # The account identity comes from device authentication, never the body.
        with patch("app.services.runner_enroll.enroll", new_callable=AsyncMock) as enroll:
            for field, value in (("orgId", self.org), ("orgId", self.foreign_org),
                                 ("ownerUserId", self.user_id), ("clientId", self.client_id)):
                rejected = await self.http.post(endpoint, json={**body, field: value})
                self.assertEqual(rejected.status_code, 422, rejected.text)
            enroll.assert_not_awaited()
        # Ordinary active accounts can create their own environment without runner.manage.
        created = await self.http.post(endpoint, json=body)
        self.assertEqual(created.status_code, 200, created.text)
        result = created.json()
        rid, key = result["environment"]["id"], result["setup"]["key"]
        self.assertTrue(key)
        self.assertEqual(result["setup"]["agentSetup"]["name"], "Pi")
        self.assertEqual(result["setup"]["agentSetup"]["command"],
                         "npm install -g @earendil-works/pi-coding-agent@0.84.4")
        async with db.SessionLocal() as session:
            self.assertTrue(await runner_registry.verify_key(session, rid, key))
            row = await session.get(RunnerNode, rid)
            self.assertEqual(row.client_id, "")
            self.assertEqual(row.org_id, self.org)
            self.assertEqual(row.owner_user_id, self.user_id)
        listing = await self.http.get(endpoint)
        self.assertNotIn(key, listing.text)
        self.assertNotIn("secret_hash", listing.text)
        environment = next(r for r in listing.json()["environments"] if r["id"] == rid)
        self.assertEqual(environment["status"], "pending")
        self.assertTrue(environment["canManage"])
        self.assertFalse(listing.json()["permissions"]["canCreate"])
        self.assertEqual(listing.json()["routing"]["mode"], "auto")
        self.assertEqual((await self.http.post(endpoint, json=body)).status_code, 409)
        changed = await self.http.patch(endpoint + "/" + rid, json={"name": "Renamed cloud", "mode": "draining"})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()["environment"]["name"], "Renamed cloud")
        self.assertEqual(changed.json()["environment"]["mode"], "draining")
        self.assertNotIn(key, changed.text)
        self.assertEqual((await self.http.patch(endpoint + "/" + rid, json={"orgId": self.foreign_org})).status_code, 422)
        self.assertEqual((await self.http.patch(endpoint + "/" + rid, json={"mode": []})).status_code, 422)
        live = self.live("online")
        runner_hub._RUNNERS.pop(live.id)
        live.id, live.owner_user_id = rid, self.user_id
        async with db.SessionLocal() as session:
            session.add(ExecutionSession(id=self.prefix + "-active", ref=self.prefix + "-ref",
                        task_id=self.prefix + "-task", runner_id=rid, state="running"))
            await session.commit()
        runner_hub._RUNNERS[rid] = live
        self.assertEqual((await self.http.delete(endpoint + "/" + rid)).status_code, 409)
        runner_hub._RUNNERS.pop(rid)
        self.assertEqual((await self.http.delete(endpoint + "/" + rid)).status_code, 409)
        async with db.SessionLocal() as session:
            active = await session.get(ExecutionSession, self.prefix + "-active")
            active.state = "done"
            await session.commit()
        # Idle online environments can be removed; their socket and key are evicted.
        runner_hub._RUNNERS[rid] = live
        self.assertEqual((await self.http.delete(endpoint + "/" + rid)).status_code, 200)
        self.assertNotIn(rid, runner_hub._RUNNERS)
        async with db.SessionLocal() as session:
            self.assertIsNone(await session.get(RunnerNode, rid))
            self.assertFalse(await runner_registry.verify_key(session, rid, key))
            self.assertIsNotNone(await session.get(ExecutionSession, self.prefix + "-active"))

    async def test_shell_unsafe_urls_rejected_before_enrollment_and_local_service_notice(self):
        endpoint = "/api/v1/cloud-environments"
        bad = ["http://good.example/&whoami", "http://good.example/$(whoami)",
               "http://good.example/`whoami`", "http://good.example/%26whoami",
               "http://user:pass@good.example", "http://good.example?q=x", "http://good.example#x",
               "file:///tmp/a", "http://good.example\nwhoami", "http://good.example:99999",
               "http://good.example/\"evil", "http://127.0.0.1:9080", "http://[::1]:9080", "http://0.0.0.0:9080"]
        with patch("app.services.runner_enroll.enroll", new_callable=AsyncMock) as enroll:
            for hub in bad:
                with self.subTest(hub=hub):
                    reply = await self.http.post(endpoint, json={"name": "Invalid", "hub": hub})
                    self.assertEqual(reply.status_code, 422, reply.text)
            enroll.assert_not_awaited()
        with patch("app.services.runner_enroll._lan_ip", return_value="192.0.2.20"):
            reply = await self.http.get("http://127.0.0.1:19080" + endpoint)
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertTrue(reply.json()["service"]["local"])
        self.assertEqual(reply.json()["service"]["recommendedHub"], "http://192.0.2.20:19080")
        relative = await self.http.post(endpoint, json={"name": "Bad path",
            "hub": "https://soduwork.example.test", "workRoot": "relative-workspace"})
        self.assertEqual(relative.status_code, 422, relative.text)

    async def test_cloud_scope_only_includes_owned_environment_even_for_manager(self):
        async with db.SessionLocal() as session:
            session.add_all([
                RunnerNode(id=self.prefix + "-owned", org_id=self.org,
                           owner_user_id=self.user_id, enroll_name="My cloud"),
                RunnerNode(id=self.prefix + "-shared", org_id=self.org, enroll_name="Hidden shared"),
                RunnerNode(id=self.prefix + "-foreign", org_id=self.foreign_org,
                           owner_user_id=self.prefix + "-foreign-owner", enroll_name="Hidden foreign"),
                RunnerNode(id=self.prefix + "-colleague", org_id=self.org,
                           owner_user_id=self.prefix + "-colleague", enroll_name="Hidden colleague"),
                RunnerNode(id=self.prefix + "-desktop", org_id=self.org, client_id=self.client_id,
                           enroll_name="Hidden own desktop"),
                RunnerNode(id=self.prefix + "-no-scope", enroll_name="Hidden unassigned"),
            ])
            await session.commit()
        endpoint = "/api/v1/cloud-environments"
        for manager in (False, True):
            if manager:
                await self.manager()
            reply = await self.http.get(endpoint)
            self.assertEqual(reply.status_code, 200, reply.text)
            self.assertEqual([r["id"] for r in reply.json()["environments"]], [self.prefix + "-owned"])
            self.assertNotIn("Hidden", reply.text)
            for suffix in ("shared", "foreign", "colleague", "desktop", "no-scope", "missing"):
                rid = self.prefix + "-" + suffix
                self.assertEqual((await self.http.patch(endpoint + "/" + rid, json={"name": "No"})).status_code, 404)
                self.assertEqual((await self.http.post(endpoint + "/" + rid + "/credentials", json={})).status_code, 404)
                self.assertEqual((await self.http.delete(endpoint + "/" + rid)).status_code, 404)

    def snapshot(self):
        data = b"A portable cloud input"
        source = {"sessionId": "local-source", "adapterId": "codex", "modelName": "",
                  "title": "Continue automatically", "goal": "", "messages": []}
        manifest = {"schema": "soduwork.workspace-handoff/v1", "source": source, "excluded": [],
                    "files": [{"path": "input.txt", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]}
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as bundle:
            bundle.writestr("manifest.json", json.dumps(manifest))
            bundle.writestr("workspace/input.txt", data)
        archive = out.getvalue()
        return archive, hashlib.sha256(archive).hexdigest()

    async def test_automatic_matching_capacity_and_pinned_retry(self):
        owned = self.live("owned")
        await self.enroll_personal(owned)
        # Saturated execution slots still accept work while the task queue has room.
        owned.busy, owned.max_concurrent = 1, 1
        owned.task_outstanding, owned.task_queue_capacity = 0, 1
        shared = self.live("shared")
        desktop = self.live("desktop", client_id=self.other_id)
        foreign = self.live("foreign")
        foreign.owner_user_id = self.prefix + "-colleague"
        async with db.SessionLocal() as session:
            row = await session.get(RunnerNode, owned.id)
            row.enroll_name = "Chosen readable name"
            session.add_all([
                RunnerNode(id=shared.id, org_id=self.org),
                RunnerNode(id=foreign.id, org_id=self.org, owner_user_id=foreign.owner_user_id),
            ])
            await session.commit()
        endpoint = "/api/v1/conversation-handoffs"
        preview = await self.http.get(endpoint + "/targets?agentId=codex")
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual([r["runnerId"] for r in preview.json()["targets"]], [owned.id])
        self.assertEqual(preview.json()["targets"][0]["runnerName"], "Chosen readable name")
        self.assertEqual(preview.json()["selection"], {"mode": "auto", "agentId": "codex", "eligibleCount": 1})
        for hidden in (shared, desktop, foreign):
            self.assertNotIn(hidden.id, preview.text)
        archive, digest = self.snapshot()
        options = {"sha256": digest, "agentId": "codex", "instruction": "Continue my report", "model": ""}
        async def prepare(transfer, opts=options):
            return await self.http.post(endpoint + "/" + transfer, files={"file": ("work.zip", archive, "application/zip")},
                                        data={"options": json.dumps(opts)})
        with patch.object(ai_exec, "load", new_callable=AsyncMock, return_value={"cfg": {}}):
            prepared = await prepare("auto-pinned")
            self.assertEqual(prepared.status_code, 200, prepared.text)
            target = prepared.json()["target"]["id"]
            self.assertEqual(target, "runner:" + owned.id + ":codex")
            # Full personal capacity cannot redirect a prepared transfer to a shared host.
            owned.task_outstanding = owned.task_queue_capacity
            retry = await prepare("auto-pinned")
            self.assertEqual(retry.status_code, 200, retry.text)
            self.assertEqual(retry.json()["target"]["id"], target)
            self.assertEqual(retry.json()["target"]["runnerName"], "Chosen readable name")
            self.assertEqual(retry.json()["target"]["runnerId"], owned.id)
            # An unreachable chosen host cannot silently dispatch to another host.
            runner_hub._RUNNERS.pop(owned.id)
            with patch("app.services.task_dispatch.dispatch", new_callable=AsyncMock) as dispatch:
                committed = await self.http.post(endpoint + "/auto-pinned/commit", json={"sha256": digest})
                self.assertEqual(committed.status_code, 409, committed.text)
                dispatch.assert_not_awaited()
            retry = await prepare("auto-pinned")
            self.assertEqual(retry.json()["target"]["id"], target)
            # Old callers selecting an explicit seat retain retry compatibility.
            runner_hub._RUNNERS[owned.id] = owned
            legacy = {"sha256": digest, "instruction": "Legacy", "assigneeId": target}
            one, two = await prepare("explicit", legacy), await prepare("explicit", legacy)
            self.assertEqual(one.status_code, 200, one.text)
            self.assertEqual(one.json(), two.json())
            full = await prepare("no-capacity")
            self.assertEqual(full.status_code, 409, full.text)
        async with db.SessionLocal() as session:
            row = await session.get(ConversationHandoff, conversation_handoffs.identity(self.client_id, "auto-pinned"))
            self.assertEqual(row.options["assigneeId"], target)
            self.assertEqual(row.phase, "prepared")
        # Free shared/colleague nodes and another own desktop are never a fallback.
        no_capacity = await self.http.get(endpoint + "/targets?agentId=codex")
        self.assertEqual(no_capacity.json()["targets"], [])
        self.assertEqual(no_capacity.json()["selection"]["eligibleCount"], 0)
        owned.task_outstanding = 0
        owned.agents = [{"key": "pi", "auth": "authed"}]
        no_agent = await self.http.get(endpoint + "/targets?agentId=codex")
        self.assertEqual(no_agent.json()["targets"], [])
        self.assertEqual(no_agent.json()["diagnostics"]["nodes"][0]["code"], "agent_unavailable")

    async def test_two_prepared_handoffs_still_reserve_capacity_at_commit(self):
        node = self.live("one-slot")
        await self.enroll_personal(node)
        node.max_concurrent, node.task_queue_capacity = 1, 1
        archive, digest = self.snapshot()
        endpoint = "/api/v1/conversation-handoffs"
        options = {"sha256": digest, "agentId": "codex", "instruction": "Continue", "model": ""}
        entered, release = threading.Event(), threading.Event()
        calls = []

        def transport(runner, op, data, timeout=60):
            self.assertEqual(op, "job.dispatch")
            calls.append(data["dispatchId"])
            entered.set()
            if not release.wait(10):
                raise AssertionError("capacity test did not release the Runner reply")
            return {"ok": True, "data": {"ref": data["dispatchId"], "state": "running"}}

        async def dispatch(task_id, body, client, session):
            task = SimpleNamespace(id=task_id)
            result = await asyncio.to_thread(ai_remote.dispatch_sync,
                {"allowedOrgs": [], "allowedClients": [], "allowedRunners": [node.id],
                 "personalRunnerOwner": client.user_ref, "personalRunnerIds": [node.id]}, task,
                assignee={"id": "runner:" + node.id + ":codex"}, files=[],
                ctx={"dispatchId": "test:" + task_id})
            if not result.get("ok"):
                raise HTTPException(409, result["error"])
            return result

        with patch.object(ai_exec, "load", new_callable=AsyncMock, return_value={"cfg": {}}), \
             patch("app.services.task_dispatch.dispatch", side_effect=dispatch), \
             patch.object(runner_hub, "call_sync", side_effect=transport):
            for transfer in ("parallel-a", "parallel-b"):
                prepared = await self.http.post(endpoint + "/" + transfer,
                    files={"file": ("work.zip", archive, "application/zip")}, data={"options": json.dumps(options)})
                self.assertEqual(prepared.status_code, 200, prepared.text)
            first = asyncio.create_task(self.http.post(endpoint + "/parallel-a/commit", json={"sha256": digest}))
            try:
                did_enter = await asyncio.to_thread(entered.wait, 5)
                if not did_enter and first.done():
                    self.fail("dispatch stopped before transport: " + (await first).text)
                self.assertTrue(did_enter)
                second = await self.http.post(endpoint + "/parallel-b/commit", json={"sha256": digest})
                self.assertEqual(second.status_code, 200, second.text)
                self.assertEqual(second.json()["phase"], "prepared")
                self.assertTrue(second.json()["error"])
                self.assertEqual(len(calls), 1, "a stale prepared choice must not bypass capacity")
            finally:
                release.set()
                completed = await first
            self.assertEqual(completed.status_code, 200, completed.text)
            self.assertEqual(completed.json()["phase"], "committed")
            self.assertFalse(runner_hub.has_capacity(node))
            repeated = await self.http.post(endpoint + "/parallel-a/commit", json={"sha256": digest})
            self.assertEqual(repeated.json()["phase"], "committed")
            self.assertEqual(len(calls), 1)
            # A later heartbeat freeing the queue permits the original second transfer.
            node.task_outstanding = 0
            retry = await self.http.post(endpoint + "/parallel-b/commit", json={"sha256": digest})
            self.assertEqual(retry.status_code, 200, retry.text)
            self.assertEqual(retry.json()["phase"], "committed")
            self.assertEqual(len(calls), 2)
            self.assertNotEqual(calls[0], calls[1])
            repeated = await self.http.post(endpoint + "/parallel-b/commit", json={"sha256": digest})
            self.assertEqual(repeated.json()["phase"], "committed")
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
