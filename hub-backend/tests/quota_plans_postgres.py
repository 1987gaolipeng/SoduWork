"""Run the plan HTTP suite on an explicitly disposable PostgreSQL database.

The caller creates/removes quota_test_<12-32 hex>. Each test creates and removes
only its own random schema. No dotenv, customer data or paid model is used.
"""
import asyncio
import copy
import os
import re
import sys
import unittest
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateSchema, DropSchema

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
raw = os.environ.get("SODUWORK_QUOTA_TEST_POSTGRES_URL", "")
url = make_url(raw) if raw else None
if not url or url.drivername != "postgresql+asyncpg" or not re.fullmatch(r"quota_test_[0-9a-f]{12,32}", url.database or "") or url.query:
    raise SystemExit("Explicit disposable PostgreSQL URL required: quota_test_<12-32 hex>")
os.environ["DATABASE_URL"] = raw
from app.config import Settings
Settings.model_config["env_file"] = None
import test_quota_plans as base


class PostgresQuotaPlans(base.QuotaPlanTests):
    async def create_database(self):
        self.schema = "quota_case_" + uuid4().hex
        self.admin_engine = create_async_engine(url, poolclass=NullPool)
        async with self.admin_engine.begin() as connection:
            await connection.execute(CreateSchema(self.schema))
        return create_async_engine(url, connect_args={"server_settings": {
            "search_path": self.schema, "statement_timeout": "20000", "lock_timeout": "15000"}})

    async def asyncTearDown(self):
        try:
            await super().asyncTearDown()
        finally:
            async with self.admin_engine.begin() as connection:
                await connection.execute(DropSchema(self.schema, cascade=True))
                self.assertIsNone(await connection.scalar(text("select to_regnamespace(:name)"), {"name": self.schema}))
            await self.admin_engine.dispose()

    async def test_competing_catalog_edits_and_first_assignments_conflict(self):
        a = copy.deepcopy(base.qp.DEFAULT_CATALOG)
        b = copy.deepcopy(a)
        a["plans"][1]["name"] = "First editor"
        b["plans"][1]["name"] = "Second editor"
        results = await asyncio.gather(*[
            self.http.put("/api/v1/admin/quotas", headers=self.headers, json=body) for body in (a, b)])
        self.assertEqual(sorted(r.status_code for r in results), [200, 409])
        results = await asyncio.gather(*[
            self.http.put("/api/v1/admin/quotas/members/owner", headers=self.headers,
                json={"revision": 0, "mode": "custom", "custom": {"totalLimit": cap}}) for cap in (10, 20)])
        self.assertEqual(sorted(r.status_code for r in results), [200, 409])


if __name__ == "__main__":
    unittest.main()
