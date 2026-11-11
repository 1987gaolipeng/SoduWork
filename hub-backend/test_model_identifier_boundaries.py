"""Admin model catalog identifiers must match the columns that store them.

Provider rows key on id[:48] silently: an overlong identifier is stored truncated, so
the create succeeds while later reads and replays keyed on the caller's identifier
miss the row (second PUT with "new" hits the primary key and 500s). These tests pin
strict validation at the HTTP boundary instead.
"""
import importlib
import os
from pathlib import Path
import unittest

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


class ModelIdentifierBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.User(id="admin", username="admin", display_name="Admin",
                                    is_super=True, is_active=True, auth_version=1,
                                    password_hash=hash_password("x" * 16)))
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

    async def test_overlong_provider_identifier_is_rejected_not_truncated(self):
        long_id = "p" * 60
        created = await self.request("PUT", f"/model-providers/{long_id}", json={
            "expectedRevision": "new", "name": "Overlong", "kind": "openai-compat",
            "baseUrl": "https://example.com/v1", "apiKey": "k", "enabled": True})
        self.assertEqual(created.status_code, 400, created.text)

        catalog = await self.request("GET", "/model-catalog")
        stored = [p["id"] for p in catalog.json()["providers"]]
        self.assertNotIn("p" * 48, stored)
        self.assertNotIn(long_id, stored)

    async def test_replayed_create_of_short_identifier_conflicts_cleanly(self):
        body = {"expectedRevision": "new", "name": "Once", "kind": "openai-compat",
                "baseUrl": "https://example.com/v1", "apiKey": "k", "enabled": True}
        first = await self.request("PUT", "/model-providers/once", json=body)
        self.assertEqual(first.status_code, 200, first.text)
        replay = await self.request("PUT", "/model-providers/once", json=body)
        self.assertEqual(replay.status_code, 409, replay.text)

    async def test_model_composite_identifier_is_within_column_limit(self):
        provider = await self.request("PUT", "/model-providers/edge", json={
            "expectedRevision": "new", "name": "Edge", "kind": "openai-compat",
            "baseUrl": "https://example.com/v1", "apiKey": "k", "enabled": True})
        self.assertEqual(provider.status_code, 200, provider.text)
        overflow = await self.request("PUT", "/model-defs", json={
            "expectedRevision": "new", "providerId": "edge",
            "name": "m" * 60, "enabled": True})
        self.assertEqual(overflow.status_code, 400, overflow.text)

        catalog = await self.request("GET", "/model-catalog")
        self.assertNotIn("edge:" + "m" * 60, [m["id"] for m in catalog.json()["models"]])

    async def test_api_key_length_reports_truncation_instead_of_hiding_it(self):
        created = await self.request("PUT", "/model-providers/longkey", json={
            "expectedRevision": "new", "name": "LongKey", "kind": "openai-compat",
            "baseUrl": "https://example.com/v1", "apiKey": "k" * 420, "enabled": True})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertTrue(created.json().get("keyTruncated"), created.text)

        catalog = await self.request("GET", "/model-catalog")
        row = next(p for p in catalog.json()["providers"] if p["id"] == "longkey")
        self.assertEqual(row["keyLen"], 400)

    async def test_wellformed_provider_and_model_round_trip(self):
        created = await self.request("PUT", "/model-providers/good", json={
            "expectedRevision": "new", "name": "Good", "kind": "openai-compat",
            "baseUrl": "https://example.com/v1", "apiKey": "k" * 300, "enabled": True})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertFalse(created.json().get("keyTruncated"), created.text)
        model = await self.request("PUT", "/model-defs", json={
            "expectedRevision": "new", "providerId": "good", "name": "gpt-mini",
            "enabled": True, "modality": "chat"})
        self.assertEqual(model.status_code, 200, model.text)

        catalog = await self.request("GET", "/model-catalog")
        self.assertIn("good", [p["id"] for p in catalog.json()["providers"]])
        self.assertIn("good:gpt-mini", [m["id"] for m in catalog.json()["models"]])

        row = next(p for p in catalog.json()["providers"] if p["id"] == "good")
        deleted = await self.request("DELETE", f"/model-providers/good?expectedRevision={row['revision']}")
        self.assertEqual(deleted.status_code, 200, deleted.text)


if __name__ == "__main__":
    unittest.main()
