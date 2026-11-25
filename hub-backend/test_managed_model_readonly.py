"""Managed model ownership through real authenticated HTTP and isolated state."""
import copy
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import select

import test_token_quota as fixture
from app import models
from app.api import model_capabilities
from app.services import client_domain_events, model_catalog


class ManagedModelReadOnlyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixture.TokenQuotaTests.asyncSetUp(self)
        await client_domain_events.stop()
        self.http._transport.app.include_router(model_capabilities.router)
        self.legacy_providers = [{"id": "managed", "baseUrl": "https://retired.invalid/v1"},
                                 {"id": "custom-managed", "personal": True, "baseUrl": "https://retired.invalid/v1"}]
        self.legacy_models = [{"providerId": "managed", "name": "retired-alias"}]
        self.legacy_keys = {"managed": "retired-personal-key", "custom-managed": "retired-collision-key"}
        async with self.sessions() as session:
            session.add_all([
                models.ModelProvider(id="managed", name="Managed", base_url="https://managed.invalid/v1", api_key="organization-fixture"),
                models.ModelProvider(id="custom-managed", name="Managed custom", base_url="https://managed.invalid/v1"),
                models.ModelDef(id="managed:company-model", provider_id="managed", name="company-model"),
                models.ModelDef(id="custom-managed:unavailable", provider_id="custom-managed", name="unavailable"),
            ])
            client = await session.get(models.Client, self.devices[0].id)
            client.config = {"modelProviders": copy.deepcopy(self.legacy_providers)}
            client.models = copy.deepcopy(self.legacy_models)
            client.model_keys = dict(self.legacy_keys)
            await session.commit()

    async def asyncTearDown(self):
        await client_domain_events.stop()
        await fixture.TokenQuotaTests.asyncTearDown(self)

    async def state(self):
        async with self.sessions() as session:
            client = await session.get(models.Client, self.devices[0].id)
            return copy.deepcopy((client.config, client.models, client.model_keys))

    async def save(self, body, headers=None):
        current = await self.http.get("/api/v1/my-models", headers=headers or self.headers)
        return await self.http.put("/api/v1/my-models", headers=headers or self.headers,
                                  json={"expectedRevision": current.json()["revision"], **body})

    async def test_legacy_overrides_are_retained_but_never_displayed_or_used(self):
        before = await self.state()
        response = await self.http.get("/api/v1/my-models", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["myModels"], [])
        self.assertEqual([row["name"] for row in response.json()["usable"]], ["company-model"])
        for row in response.json()["providers"]:
            self.assertEqual(row["baseUrl"], "https://managed.invalid/v1")
            self.assertFalse(row["personal"])
            self.assertFalse(row["addressOverridden"])
            self.assertFalse(row["myKeySet"])
        self.assertNotIn("retired", response.text)
        self.assertNotIn("organization-fixture", response.text)
        async with self.sessions() as session:
            client = await session.get(models.Client, self.devices[0].id)
            conf = await model_catalog.resolve(session, client, "company-model")
            self.assertEqual((conf["base"], conf["keyFrom"], conf["key"], conf["fundingScope"]),
                             ("https://managed.invalid/v1", "org", "organization-fixture", "platform"))
            self.assertEqual(await model_catalog.resolve(session, client, "retired-alias"), {})
            self.assertEqual(await model_catalog.resolve(session, client, "unavailable"), {})
        self.assertEqual(await self.state(), before)
        await fixture.TokenQuotaTests.override(self, "limited", 0)
        denied = await self.http.get("/api/v1/ai-proxy/config?agent=pi&model=company-model", headers=self.headers)
        self.assertEqual(denied.status_code, 403)

    async def test_forged_managed_edits_and_mixed_saves_are_atomic(self):
        before = await self.state()
        bodies = [
            {"providers": [{"id": "managed", "personal": True, "baseUrl": "https://changed.invalid/v1"}]},
            {"providers": [{"id": "custom-managed", "personal": True, "name": "Forged", "baseUrl": "https://changed.invalid/v1"}]},
            {"keys": {"managed": "changed"}}, {"keys": {"managed": None}},
            {"models": [{"providerId": "managed", "name": "new", "own": True}]},
            {"providers": [{"id": "custom-mine", "name": "Mine", "baseUrl": "https://mine.invalid/v1"}],
             "keys": {"custom-mine": "own-key", "managed": "forged"}},
            {"models": [{"providerId": "custom-mine", "name": "mine"}] * 40 +
                       [{"providerId": "managed", "name": "hidden-after-limit"}]},
        ]
        with patch.object(client_domain_events, "device_changed", new_callable=AsyncMock) as notify:
            for body in bodies:
                with self.subTest(body=body):
                    response = await self.save(body)
                    self.assertEqual(response.status_code, 403, response.text)
                    self.assertEqual(await self.state(), before)
            notify.assert_not_awaited()
        echoed = await self.http.put("/api/v1/config", headers=self.headers,
                                    json={"theme": "dark", "modelProviders": []})
        self.assertEqual(echoed.status_code, 200)
        self.assertEqual((await self.state())[0]["modelProviders"], self.legacy_providers)

    async def test_personal_crud_preserves_retired_managed_records_and_device_scope(self):
        provider = {"id": "custom-mine", "name": "Mine", "baseUrl": "https://mine.invalid/v1"}
        response = await self.save({"providers": [provider], "keys": {"custom-mine": "own-fixture"},
                                    "models": [{"providerId": "custom-mine", "name": "mine"}]})
        self.assertEqual(response.status_code, 200, response.text)
        private = next(row for row in response.json()["usable"] if row["name"] == "mine")
        self.assertEqual((private["own"], private["keyFrom"]), (True, "mine"))
        second = await self.http.get("/api/v1/my-models", headers=self.second_headers)
        self.assertNotIn("custom-mine", second.text)
        changed = await self.save({"providers": [{**provider, "baseUrl": "https://updated.invalid/v1"}],
                                  "keys": {"custom-mine": "updated-fixture"}})
        self.assertEqual(changed.status_code, 200, changed.text)
        with patch.object(model_catalog, "probe_sync", return_value={"ok": True}) as probe:
            checked = await self.http.post("/api/v1/my-models/test", headers=self.headers,
                                           json={"providerId": "custom-mine"})
            self.assertEqual(checked.status_code, 200)
            self.assertEqual(probe.call_args.args[:2], ("https://updated.invalid/v1", "updated-fixture"))
        removed = await self.save({"providers": [], "models": []})
        self.assertEqual(removed.status_code, 200, removed.text)
        config, models_, keys = await self.state()
        self.assertEqual(config["modelProviders"], self.legacy_providers)
        self.assertEqual(models_, self.legacy_models)
        self.assertEqual(keys, self.legacy_keys)

    async def test_invalid_personal_model_config_preserves_models_providers_and_keys(self):
        provider = {"id": "custom-mine", "name": "Mine", "baseUrl": "https://mine.invalid/v1"}
        model = {"providerId": "custom-mine", "name": "mine", "label": "Original",
                 "config": {"capabilities": {"toolCalling": "supported", "streaming": "supported"}}}
        response = await self.save({"providers": [provider], "models": [model],
                                    "keys": {"custom-mine": "original-fixture"}})
        self.assertEqual(response.status_code, 200, response.text)
        before = await self.state()
        saved_model = next(row for row in before[1] if row["providerId"] == "custom-mine")
        self.assertEqual(saved_model["config"]["capabilities"], model["config"]["capabilities"])
        with patch.object(client_domain_events, "device_changed", new_callable=AsyncMock) as notify:
            for malformed in ([], "not-an-object"):
                with self.subTest(config=malformed):
                    response = await self.save({
                        "providers": [{**provider, "name": "Changed", "baseUrl": "https://changed.invalid/v1"}],
                        "models": [{**model, "label": "Changed", "config": malformed}],
                        "keys": {"custom-mine": "changed-fixture"},
                    })
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertEqual(response.headers.get("X-Error-Code"), "model.config.invalid-object")
                    self.assertEqual(await self.state(), before)
            notify.assert_not_awaited()

    async def test_managed_probes_never_contact_upstream_or_write_global_evidence(self):
        with patch.object(model_catalog, "probe_sync") as probe, \
                patch.object(model_capabilities.probe, "run", new_callable=AsyncMock) as capability_probe:
            for pid in ("managed", "custom-managed"):
                response = await self.http.post("/api/v1/my-models/test", headers=self.headers,
                                               json={"providerId": pid, "personal": True})
                self.assertEqual(response.status_code, 403, response.text)
                response = await self.http.post("/api/v1/my-models/capabilities/check", headers=self.headers,
                                               json={"providerId": pid, "model": "company-model", "checks": ["connection"]})
                self.assertEqual(response.status_code, 403, response.text)
            forged_scope = await self.http.post("/api/v1/my-models/capabilities/check", headers=self.headers,
                json={"providerId": "managed", "model": "company-model", "checks": ["connection"], "scope": "personal"})
            self.assertEqual(forged_scope.status_code, 400)
            probe.assert_not_called()
            capability_probe.assert_not_awaited()
        async with self.sessions() as session:
            records = list((await session.scalars(select(models.AppSetting).where(
                models.AppSetting.key.like("model-check-v1:%")))).all())
            self.assertEqual(records, [])
        blocked_admin = await self.http.post("/api/v1/admin/model-capabilities/check", headers=self.headers,
                                            json={"providerId": "managed", "model": "company-model"})
        self.assertIn(blocked_admin.status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
