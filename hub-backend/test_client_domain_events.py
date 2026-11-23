"""Domain invalidations preserve committed API responses and release DB before fanout."""
import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import event
from test_model_runtime import IsolatedDatabase
from app.models import Client, ModelDef, ModelProvider, User
from app.api import admin, config, personal_models, agents, model_capabilities
from app.services import client_domain_events as events, model_catalog, model_config_guard


class ClientDomainEventsTests(IsolatedDatabase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await events.stop()
        async with self.engine.begin() as connection:
            await connection.run_sync(User.__table__.create)
        async with self.sessions() as session, session.begin():
            session.add_all([
                User(id="alice", username="fixture-alice", is_active=True),
                User(id="bob", username="fixture-bob", is_active=True),
                Client(id="one", user_ref="alice", auth_state="active", model_keys={"custom-personal": "personal-fixture"},
                       config={"modelProviders": [{"id": "custom-personal", "name": "Personal",
                                                    "baseUrl": "https://personal.invalid/v1", "personal": True}]},
                       models=[{"providerId": "custom-personal", "name": "personal-model"}]),
                Client(id="two", user_ref="alice", auth_state="active"),
                Client(id="other", user_ref="bob", auth_state="active"),
                Client(id="revoked", user_ref="alice", auth_state="revoked"),
                ModelProvider(id="provider", api_key="organization-fixture", base_url="https://fixture.invalid"),
                ModelDef(id="provider:model", provider_id="provider", name="model"),
            ])

    async def asyncTearDown(self):
        await events.stop()
        await super().asyncTearDown()

    async def test_private_settings_are_device_scoped_and_keep_legacy_shapes(self):
        with patch.object(events.native_discovery, "wake", new_callable=AsyncMock) as wake:
            async with self.sessions() as session:
                client = await session.get(Client, "one")
                result = await personal_models.put_my_models({"keys": {"custom-personal": "replacement-fixture"}}, client, session)
                self.assertEqual(set(result), {"ok", "usable", "mediaUsable"})
                await agents.put_agent_model({"key": "pi", "model": "model"}, client, session)
                self.assertEqual(await config.put_config({"theme": "dark", "modelProviders": []}, client, session), {"theme": "dark"})
            wake.assert_not_awaited()
            await events.flush_for_test(self.sessions)
            self.assertEqual({call.args for call in wake.await_args_list},
                             {("one", "alice", "models"), ("one", "alice", "config")})

    async def test_personal_model_add_can_request_its_committed_revision(self):
        async with self.sessions() as session:
            client = await session.get(Client, "one")
            before = model_config_guard.revision(client)
            result = await personal_models.put_my_models({
                "models": [*client.models, {"providerId": "custom-personal", "name": "added-model"}],
                "expectedRevision": before, "returnRevision": True,
            }, client, session)
        async with self.sessions() as session:
            saved = await session.get(Client, "one")
            self.assertIn("added-model", [row["name"] for row in saved.models])
            self.assertNotEqual(before, result["revision"])
            self.assertEqual(result["revision"], model_config_guard.revision(saved))

    async def test_personal_add_target_revision_belongs_to_the_write_even_after_a_concurrent_edit(self):
        model = {"providerId": "custom-personal", "name": "added-model"}
        media = [{"providerId": "custom-personal", "name": f"added-{kind}", "modality": kind, "label": "First"}
                 for kind in ("image", "video")]
        targets = []
        async with self.sessions() as session:
            client = await session.get(Client, "one")
            commit = session.commit

            async def commit_then_edit():
                await commit()
                async with self.sessions() as other:
                    writer = await other.get(Client, "one")
                    choices = await model_catalog.usable(other, writer)
                    targets.append(next(row["configRevision"] for row in choices if row["name"] == model["name"]))
                    newer = await personal_models.put_my_models({
                        "expectedRevision": model_config_guard.revision(writer),
                        "models": [{**model, "ctxWindow": 96000}] + [{**row, "label": "Second"} for row in media],
                    }, writer, other)
                    targets.append(next(row["configRevision"] for row in newer["usable"] if row["name"] == model["name"]))

            with patch.object(session, "commit", commit_then_edit):
                saved = await personal_models.put_my_models({
                    "expectedRevision": model_config_guard.revision(client), "returnRevision": True, "models": [model, *media],
                }, client, session)
        self.assertNotEqual(targets[0], targets[1])
        self.assertEqual(next(row["configRevision"] for row in saved["usable"] if row["name"] == model["name"]), targets[0])
        for row in media:
            with self.subTest(modality=row["modality"]):
                choices = saved["mediaUsable"][row["modality"]]
                self.assertEqual(next(item["label"] for item in choices if item["name"] == row["name"]), "First")

    async def test_catalog_edits_coalesce_for_every_active_device(self):
        with patch.object(events.native_discovery, "wake", new_callable=AsyncMock) as wake, patch.object(admin.audit, "log", new_callable=AsyncMock):
            async with self.sessions() as session:
                provider = await session.get(ModelProvider, "provider")
                await admin.put_model_provider("provider", {"expectedRevision": model_config_guard.revision(provider), "note": "updated"}, None, session)
                model = await session.get(ModelDef, "provider:model")
                await admin.put_model_def({"providerId": "provider", "name": "model", "expectedRevision": model_config_guard.revision(model), "label": "Updated"}, None, session)
                await admin.del_model_def("provider:model", model_config_guard.revision(model), None, session)
                actor = await session.get(User, "alice")
                preview = await admin.model_provider_deletion_impact("provider", actor, session)
                await admin.del_model_provider("provider", model_config_guard.revision(provider), actor, session,
                                               confirmId="provider", expectedImpact=preview["impactRevision"])
            wake.assert_not_awaited()
            await events.flush_for_test(self.sessions)
            self.assertEqual({call.args for call in wake.await_args_list},
                             {("one", "alice", "models"), ("two", "alice", "models"), ("other", "bob", "models")})

    async def test_capability_evidence_invalidates_its_actual_credential_scope(self):
        body = {"providerId": "provider", "model": "model", "checks": ["imageInput"]}
        with patch.object(events.native_discovery, "wake", new_callable=AsyncMock) as wake, \
                patch.object(model_capabilities.probe, "run", new_callable=AsyncMock,
                             return_value={"checks": {"imageInput": {"status": "passed"}}}):
            async with self.sessions() as session:
                await model_capabilities.check_saved({**body, "providerId": "custom-personal", "model": "personal-model"},
                                                    session, await session.get(Client, "one"))
            await events.flush_for_test(self.sessions)
            self.assertEqual([call.args for call in wake.await_args_list], [("one", "alice", "models")])
            wake.reset_mock()
            async with self.sessions() as session:
                await model_capabilities.check_saved(body, session)
            await events.flush_for_test(self.sessions)
            self.assertEqual(len(wake.await_args_list), 3)

    async def test_postcommit_response_never_waits_for_transport_and_target_read_releases_connection(self):
        held = 0
        def checkout(*_):
            nonlocal held
            held += 1
        def checkin(*_):
            nonlocal held
            held -= 1
        event.listen(self.engine.sync_engine, "checkout", checkout)
        event.listen(self.engine.sync_engine, "checkin", checkin)
        release, entered = asyncio.Event(), asyncio.Event()
        async def blocked(*_):
            self.assertEqual(held, 0)
            entered.set()
            await release.wait()
        with patch.object(events.native_discovery, "wake", side_effect=blocked) as wake:
            async with self.sessions() as session:
                client = await session.get(Client, "one")
                result = await asyncio.wait_for(config.put_config({"theme": "dark"}, client, session), 1)
                self.assertEqual(result, {"theme": "dark"})
                wake.assert_not_awaited()
            async with self.sessions() as verify:
                self.assertEqual((await verify.get(Client, "one")).config["theme"], "dark")
            task = asyncio.create_task(events.flush_for_test(self.sessions))
            await asyncio.wait_for(entered.wait(), 1)
            release.set()
            await task

    async def test_overflow_stays_bounded_and_never_expands_private_targets(self):
        with patch.object(events, "MAX_PENDING", 2), patch.object(events.native_discovery, "wake", new_callable=AsyncMock) as wake:
            await events.account_changed(None, "discarded", "conversation-projects")
            await events.account_changed(None, "alice", "conversation-projects")
            await events.account_changed(None, "bob", "conversation-projects")
            self.assertEqual(len(events._pending), 2)
            self.assertNotIn(("conversation-projects", "", ""), events._pending)
            await events.flush_for_test(self.sessions)
            self.assertEqual(len(wake.await_args_list), 3)

    async def test_audit_failure_after_model_commit_cannot_skip_invalidation(self):
        with patch.object(admin.audit, "log", new_callable=AsyncMock, side_effect=OSError("audit unavailable")), \
                patch.object(events.native_discovery, "wake", new_callable=AsyncMock) as wake:
            async with self.sessions() as session:
                provider = await session.get(ModelProvider, "provider")
                with self.assertRaisesRegex(OSError, "audit unavailable"):
                    await admin.put_model_provider("provider", {"expectedRevision": model_config_guard.revision(provider),
                                                              "note": "committed"}, None, session)
            await events.flush_for_test(self.sessions)
            self.assertEqual(len(wake.await_args_list), 3)
            async with self.sessions() as session:
                self.assertEqual((await session.get(ModelProvider, "provider")).note, "committed")

    async def test_legacy_config_push_failure_preserves_error_and_already_queued_hint(self):
        with patch.object(admin, "_assert_client_in_scope", new_callable=AsyncMock), \
                patch.object(admin.hub, "publish", new_callable=AsyncMock, side_effect=OSError("socket unavailable")), \
                patch.object(events.native_discovery, "wake", new_callable=AsyncMock) as wake:
            async with self.sessions() as session:
                with self.assertRaisesRegex(OSError, "socket unavailable"):
                    await admin.client_push("one", {"type": "config.patch", "patch": {"theme": "dark"}},
                                            SimpleNamespace(id="admin"), session)
            await events.flush_for_test(self.sessions)
            self.assertEqual([call.args for call in wake.await_args_list], [("one", "alice", "config")])
            async with self.sessions() as session:
                self.assertEqual((await session.get(Client, "one")).config["theme"], "dark")

    async def test_admin_client_detail_hides_local_model_configuration(self):
        async with self.sessions() as session:
            client = await session.get(Client, "one")
            client.config = {
                "theme": "dark",
                "modelProviders": [{"id": "custom-local", "localOnly": True,
                                     "baseUrl": "http://127.0.0.1:8686/v1"}],
            }
            await session.commit()
            result = admin._admin_client_config(client.config)
        self.assertEqual(result, {"theme": "dark"})

    async def test_admin_cannot_push_local_model_configuration(self):
        with patch.object(admin, "_assert_client_in_scope", new_callable=AsyncMock):
            async with self.sessions() as session:
                before = copy.deepcopy((await session.get(Client, "one")).config)
                with self.assertRaises(HTTPException) as raised:
                    await admin.client_push(
                        "one",
                        {"type": "config.patch", "patch": {
                            "modelProviders": [{"id": "custom-local", "localOnly": True}],
                        }},
                        SimpleNamespace(id="admin"), session,
                    )
                self.assertEqual(raised.exception.status_code, 403)
                self.assertIn("本地模型配置", str(raised.exception.detail))
                client = await session.get(Client, "one")
                self.assertEqual(client.config, before)

    async def test_personal_model_read_purges_legacy_local_state(self):
        async with self.sessions() as session:
            client = await session.get(Client, "one")
            client.config = {
                "theme": "dark",
                "modelProviders": [{"id": "custom-local", "localOnly": True,
                                     "baseUrl": "http://127.0.0.1:8686/v1"}],
            }
            client.models = [{"providerId": "custom-local", "name": "llama3", "localOnly": True}]
            client.model_keys = {"custom-local": "local-secret", "provider": "managed-secret"}
            await session.commit()
            result = await personal_models.my_models(client, session)
            self.assertEqual(result["myModels"], [])
            persisted = await session.get(Client, "one")
            self.assertNotIn("modelProviders", persisted.config or {})
            self.assertEqual(persisted.models, [])
            self.assertEqual(persisted.model_keys, {"provider": "managed-secret"})

            orphan = await session.get(Client, "two")
            orphan.models = [{"providerId": "custom-orphan", "name": "llama3", "localOnly": True}]
            orphan.model_keys = {"custom-orphan": "orphan-secret"}
            await session.commit()
            await personal_models.my_models(orphan, session)
            persisted_orphan = await session.get(Client, "two")
            self.assertEqual(persisted_orphan.models, [])
            self.assertEqual(persisted_orphan.model_keys, {})

    async def test_personal_model_write_rejects_local_provider_payload(self):
        async with self.sessions() as session:
            client = await session.get(Client, "one")
            revision = model_config_guard.revision(client)
            with self.assertRaises(HTTPException) as raised:
                await personal_models.put_my_models(
                    {"expectedRevision": revision, "providers": [{
                        "id": "custom-local", "name": "Local", "localOnly": True,
                        "baseUrl": "http://127.0.0.1:8686/v1",
                    }]},
                    client,
                    session,
                )
            self.assertEqual(raised.exception.status_code, 403)

    async def test_personal_model_write_rejects_local_only_rows_without_reserved_ids(self):
        async with self.sessions() as session:
            client = await session.get(Client, "one")
            revision = model_config_guard.revision(client)
            with self.assertRaises(HTTPException) as raised:
                await personal_models.put_my_models(
                    {"expectedRevision": revision, "providers": [{
                        "id": "desktop-service", "name": "Local", "localOnly": True,
                        "baseUrl": "http://127.0.0.1:8686/v1",
                    }]},
                    client,
                    session,
                )
            self.assertEqual(raised.exception.status_code, 403)

    async def test_personal_model_read_purges_local_only_rows_without_reserved_ids(self):
        async with self.sessions() as session:
            client = await session.get(Client, "one")
            client.config = {"modelProviders": [{
                "id": "desktop-service", "localOnly": True,
                "baseUrl": "http://127.0.0.1:8686/v1",
            }]}
            client.models = [{"providerId": "desktop-service", "name": "llama3", "localOnly": True}]
            client.model_keys = {"desktop-service": "local-secret", "provider": "managed-secret"}
            await session.commit()
            await personal_models.my_models(client, session)
            persisted = await session.get(Client, "one")
            self.assertNotIn("modelProviders", persisted.config or {})
            self.assertEqual(persisted.models, [])
            self.assertEqual(persisted.model_keys, {"provider": "managed-secret"})
