"""Inbox count uses a scalar query with the same visibility as the item list."""
import os
import unittest

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("ADMIN_PASS", "isolated-count-fixture")

from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.db import Base
from app.services import inbox


class InboxCountTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="root", name="Root"),
                models.OrgUnit(id="own", name="Own", parent_id="root"),
                models.OrgUnit(id="child", name="Child", parent_id="own"),
                models.OrgUnit(id="sibling", name="Sibling", parent_id="root"),
                models.User(id="active", username="active", org_id="own", is_active=True),
                models.User(id="inactive", username="inactive", org_id="own", is_active=False),
                models.Client(id="active", user_ref="active"),
                models.Client(id="inactive", user_ref="inactive"),
                models.Client(id="unbound"),
            ])
            await session.flush()
            for name, org, status, owner in [
                ("ancestor", "root", "todo", None), ("own", "own", "doing", None),
                ("descendant", "child", "todo", None), ("outside", "sibling", "todo", None),
                ("done", "own", "done", None), ("assigned", "own", "todo", "active"),
            ]:
                session.add(models.Task(id=name, title=name, note="large-body-" * 1000,
                                        pool_org_id=org, status=status, owner_client_id=owner))
            await session.commit()
        self.statements = []
        event.listen(self.engine.sync_engine, "before_cursor_execute",
                     lambda _c, _cur, sql, _p, _ctx, _many: self.statements.append(sql.lower()))

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_count_matches_visible_unassigned_active_rows(self):
        async with self.sessions() as session:
            client = await session.get(models.Client, "active")
            self.assertEqual(await inbox.inbox_count(session, client), 3)
            _, scope = await inbox._me_scope(session, client)
            rows = await inbox._pool_query(session, scope)
            self.assertEqual({row.id for row in rows}, {"ancestor", "own", "descendant"})

    async def test_count_does_not_fetch_or_sort_task_payloads(self):
        async with self.sessions() as session:
            client = await session.get(models.Client, "active")
            self.statements.clear()
            self.assertEqual(await inbox.inbox_count(session, client), 3)
            queries = [sql for sql in self.statements if "from task" in sql]
            self.assertEqual(len(queries), 1)
            self.assertIn("count(", queries[0])
            self.assertNotIn("task.note", queries[0])
            self.assertNotIn("order by", queries[0])
            self.assertFalse(any(isinstance(row, models.Task) for row in session.identity_map.values()))

    async def test_inactive_and_unbound_clients_do_not_query_task_rows(self):
        async with self.sessions() as session:
            for name in ("inactive", "unbound"):
                client = await session.get(models.Client, name)
                self.statements.clear()
                self.assertEqual(await inbox.inbox_count(session, client), 0)
                self.assertFalse(any("from task" in sql for sql in self.statements))


if __name__ == "__main__":
    unittest.main()
