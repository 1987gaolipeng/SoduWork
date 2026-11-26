"""Admin model-list routes for draft connections and saved-provider discovery."""
import importlib
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import hash_password, sign_token
from app.db import Base, get_session

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class ModelDiscoveryEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.User(id="admin", username="admin", display_name="Admin",
                                    is_super=True, is_active=True, auth_version=1,
                                    password_hash=hash_password("x" * 16)))
            session.add(models.ModelProvider(id="good", name="Good", kind="openai-compat",
                                             base_url="https://gw.example/v1", api_key="k",
                                             builtin=False, enabled=True))
            session.add(models.ModelProvider(id="dark", name="Dark", kind="openai-compat",
                                             base_url="", api_key="", builtin=False, enabled=True))
            session.add(models.ModelDef(id="good:known-model", provider_id="good",
                                         name="known-model", builtin=False, enabled=True))
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                      base_url="http://isolated")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, path, **kwargs):
        headers = {"Authorization": "Bearer " + sign_token("admin", 1)}
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)

    async def test_unknown_provider_is_404(self):
        resp = await self.request("POST", "/model-providers/nope/discover")
        self.assertEqual(resp.status_code, 404, resp.text)

    async def test_incomplete_provider_fails_soft_without_network(self):
        resp = await self.request("POST", "/model-providers/dark/discover")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["models"], [])

    async def test_discover_returns_new_names_and_lists_known_ones(self):
        from app.services import model_discovery
        calls = []

        def upstream_response(request):
            calls.append((request.method, str(request.url), request.headers["Authorization"]))
            return httpx.Response(200, json={"data": [
                {"id": "known-model", "output": "text"}, {"id": "fresh-a"},
                {"id": "fresh-b", "output": "decision"}]})

        upstream = httpx.AsyncClient(transport=httpx.MockTransport(upstream_response))
        with patch.object(model_discovery.httpx, "AsyncClient", return_value=upstream):
            resp = await self.request("POST", "/model-providers/good/discover")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["models"], ["fresh-a", "fresh-b"])
        self.assertEqual(body["known"], ["known-model"])
        self.assertEqual(body["candidates"], [{"id": "fresh-a", "purposes": [], "status": "unknown"},
                                             {"id": "fresh-b", "purposes": [], "status": "unsupported"}])
        self.assertEqual(body["counts"], {"total": 3, "chat": 1, "unknown": 1})
        self.assertEqual(calls, [("GET", "https://gw.example/v1/models", "Bearer k")])

    async def test_discovery_never_writes_model_rows(self):
        from app.services import model_discovery
        with patch.object(model_discovery, "discover",
                          AsyncMock(return_value={"ok": True, "models": ["ghost"],
                                                  "path": "/models", "detail": ""})):
            resp = await self.request("POST", "/model-providers/good/discover")
        self.assertEqual(resp.status_code, 200, resp.text)
        catalog = await self.request("GET", "/model-catalog")
        ids = [m["id"] for m in catalog.json()["models"]]
        self.assertNotIn("good:ghost", ids)

    async def test_unsaved_connection_uses_draft_values_without_writing(self):
        from app.services import model_discovery
        result = {"ok": True, "models": ["fixture-model"], "path": "/v1/models", "detail": "",
                  "candidates": [{"id": "fixture-model", "purposes": [], "status": "unknown"}],
                  "counts": {"total": 1, "chat": 0, "unknown": 1}}
        draft = {"kind": "anthropic", "baseUrl": "https://draft.example", "apiKey": "draft-key"}
        with patch.object(model_discovery, "discover", AsyncMock(return_value=result)) as discover:
            response = await self.request("POST", "/model-providers/test-connection", json=draft)
        self.assertEqual(response.json(), result)
        discover.assert_awaited_once_with("https://draft.example", "draft-key", "anthropic", allow_empty=True)
        catalog = (await self.request("GET", "/model-catalog")).json()
        self.assertEqual({p["id"] for p in catalog["providers"]}, {"dark", "good"})
        self.assertEqual([m["name"] for m in catalog["models"]], ["known-model"])

    async def test_saved_connection_key_stays_bound_to_its_address_and_protocol(self):
        from app.services import model_discovery
        path = "/model-providers/test-connection"
        draft = {"providerId": "good", "baseUrl": "https://gw.example/v1", "kind": "openai-compat"}
        with patch.object(model_discovery, "discover", AsyncMock(return_value={"ok": True, "models": []})) as discover:
            response = await self.request("POST", path, json=draft)
            self.assertTrue(response.json()["ok"])
            discover.assert_awaited_once_with(draft["baseUrl"], "k", draft["kind"], allow_empty=True)
            discover.reset_mock()
            for change in ({"baseUrl": "https://other.example"}, {"kind": "anthropic"}):
                response = await self.request("POST", path, json={**draft, **change})
                self.assertEqual(response.json()["code"], "model.discovery.reenter-key")
            discover.assert_not_awaited()
            response = await self.request("POST", path, json={**draft, "baseUrl": "https://other.example", "apiKey": "replacement"})
            self.assertTrue(response.json()["ok"])
            discover.assert_awaited_once_with("https://other.example", "replacement", draft["kind"], allow_empty=True)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.ModelProvider, "good")).api_key, "k")


if __name__ == "__main__":
    unittest.main()
