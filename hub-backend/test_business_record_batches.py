"""Cross-domain permission, transaction and retry rules for catalog maintenance."""
import unittest

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.business_records import Batch, _batch
from app.db import Base
from app.models import AuditLog, OrgUnit, Position, Project, Repo, User


class BusinessRecordBatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        engine = create_async_engine("sqlite+aiosqlite://")
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as conn:
            await conn.run_sync(lambda db: Base.metadata.create_all(db, tables=[
                model.__table__ for model in (OrgUnit, User, Project, Repo, Position, AuditLog)]))
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with self.sessions() as session:
            session.add_all([OrgUnit(id="a", name="A"), OrgUnit(id="b", name="B"),
                User(id="manager", org_id="a", username="manager"),
                Project(id="a1", org_id="a"), Project(id="b1", org_id="b"),
                Repo(id="r1", org_id="a", project_id="a1"), Repo(id="r2", org_id="b", project_id="b1"),
                Position(id="local", name="Local", org_id="a"),
                Position(id="baseline", name="Built in", is_system=True)])
            await session.commit()

    async def apply(self, model, ids, action="archive", scope=""):
        async with self.sessions() as session:
            actor = await session.get(User, "manager")
            return await _batch(session, actor, model, Batch(ids=ids, action=action, scopeId=scope))

    async def test_mixed_batches_leave_valid_records_and_audit_untouched(self):
        for model, ids, scope, status in (
                (Project, ["a1", "b1"], "", 403),
                (Project, ["a1", "missing"], "", 404),
                (Repo, ["r1", "r2"], "a1", 403),
                (Position, ["local", "baseline"], "a", 403)):
            with self.subTest(model=model.__name__, ids=ids):
                with self.assertRaises(HTTPException) as result:
                    await self.apply(model, ids, scope=scope)
                self.assertEqual(result.exception.status_code, status)
                async with self.sessions() as session:
                    self.assertFalse((await session.get(model, ids[0])).is_archived)
                    self.assertEqual(await session.scalar(select(func.count()).select_from(AuditLog)), 0)

    async def test_retry_is_idempotent_and_restore_keeps_the_source(self):
        self.assertEqual(await self.apply(Project, ["a1"], "test"), {"changed": 1})
        self.assertEqual(await self.apply(Project, ["a1", "a1"]), {"changed": 1})
        self.assertEqual(await self.apply(Project, ["a1"]), {"changed": 0})
        self.assertEqual(await self.apply(Project, ["a1"], "restore"), {"changed": 1})
        async with self.sessions() as session:
            row = await session.get(Project, "a1")
            self.assertEqual((row.data_source, row.is_archived), ("test", False))
            self.assertEqual(await session.scalar(select(func.count()).select_from(AuditLog)), 3)


if __name__ == "__main__":
    unittest.main()
