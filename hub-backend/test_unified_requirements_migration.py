"""Immutable legacy records, attachments and single-delivery migration."""
import importlib
import os
import unittest
from datetime import datetime, timezone

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import sqlalchemy as sa
from sqlalchemy.orm import Session
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app import models
from app.db import Base

migration = importlib.import_module("migrations.versions.0053_unified_requirements")


class RequirementMigrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = sa.create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        with self.engine.begin() as connection:
            with Operations.context(MigrationContext.configure(connection)):
                importlib.import_module("migrations.versions.0030_work_item_pool").upgrade()
                importlib.import_module("migrations.versions.0032_work_item_participants").upgrade()
        self.old = sa.Table("work_item", sa.MetaData(), autoload_with=self.engine)
        with Session(self.engine) as session:
            session.add(models.Client(id="owner"))
            session.add(models.Task(id="delivery", owner_client_id="owner", title="Private original",
                                    note="Private execution instructions", status="doing"))
            session.add(models.Task(id="collision", owner_client_id="owner", title="Unrelated task"))
            session.commit()

    def tearDown(self):
        self.engine.dispose()

    def old_row(self, rid, **updates):
        now = datetime.now(timezone.utc)
        row = dict(id=rid, org_id="org", created_by_user_id="creator", created_by_client_id="owner",
                   created_by_name="Creator", title="Original " + rid, kind="bug", description="Background " + rid,
                   acceptance_criteria=["Accept " + rid], status="ready", priority="high", source="support",
                   tags=["original"], repo_id="", requester_name="Requester", requester_contact="contact",
                   assignee_name="Assignee", version=3, created_at=now, updated_at=now)
        row.update(updates)
        with self.engine.begin() as connection:
            connection.execute(self.old.insert().values(**row))
        return row

    def migrate(self):
        with self.engine.begin() as connection:
            migration.adopt(connection)

    def test_many_sources_merge_without_extra_executor_or_private_context_disclosure(self):
        self.old_row("one", delivery_task_id="delivery", status="delivering")
        self.old_row("two", delivery_task_id="delivery", status="delivering", automation_schedule_id="schedule")
        with Session(self.engine) as session:
            session.add(models.Attachment(id="original-file", task_id="one", source_ref="work-item:one",
                filename="source.md", storage_key="unchanged/object/key", backend="local", role="input",
                evidence_meta={"field": "acceptance", "criterionText": "Accept one"}))
            session.commit()
        self.migrate()
        with Session(self.engine) as session:
            task = session.get(models.Task, "delivery")
            self.assertEqual(session.scalar(sa.select(sa.func.count()).select_from(models.Task)), 2)
            self.assertEqual(task.status, "doing")
            self.assertEqual(task.note, "Private execution instructions")
            self.assertNotIn("Private", str(task.requirement_content))
            self.assertEqual({row["id"] for row in task.legacy_requirements}, {"one", "two"})
            self.assertEqual(task.legacy_requirements[1]["automation_schedule_id"], "schedule")
            self.assertEqual(task.acceptance_criteria, ["Accept one", "Accept two"])
            attachment = session.get(models.Attachment, "original-file")
            self.assertEqual(attachment.task_id, "delivery")
            self.assertEqual(attachment.storage_key, "unchanged/object/key")
            self.assertEqual(attachment.evidence_meta["criterionText"], "Accept one")
            self.assertEqual(attachment.evidence_meta["kind"], "requirement_input")
        self.assertFalse(sa.inspect(self.engine).has_table("work_item"))
        self.migrate()
        with Session(self.engine) as session:
            self.assertEqual(session.scalar(sa.select(sa.func.count()).select_from(models.Task)), 2)
            self.assertEqual(len(session.get(models.Task, "delivery").legacy_requirements), 2)

    def test_unlinked_missing_delivery_collision_and_archived_completion_are_preserved(self):
        self.old_row("intake", status="intake")
        self.old_row("missing", status="delivering", delivery_task_id="deleted-delivery")
        self.old_row("collision", status="clarifying")
        self.old_row("closed", status="closed", delivered_at=datetime.now(timezone.utc))
        self.old_row("abandoned", status="closed")
        self.migrate()
        with Session(self.engine) as session:
            self.assertEqual(session.get(models.Task, "intake").triage_stage, "intake")
            self.assertEqual(session.get(models.Task, "missing").status, "todo")
            self.assertEqual(session.get(models.Task, "collision").title, "Unrelated task")
            sources = [row for row in session.scalars(sa.select(models.Task)) if row.legacy_requirements]
            self.assertEqual(len(sources), 5)
            closed = session.get(models.Task, "closed")
            self.assertEqual(closed.status, "done")
            self.assertIsNotNone(closed.archived_at)
            self.assertIsNone(closed.reviewed_at, "Migration must not invent human acceptance")
            self.assertEqual(session.get(models.Task, "abandoned").status, "cancel")

    def test_failure_does_not_drop_source_or_leave_partial_data(self):
        self.old_row("one")
        with Session(self.engine) as session:
            session.add(models.Attachment(id="orphan", task_id="missing", source_ref="work-item:missing",
                filename="still-there.md", storage_key="keep-this-file"))
            session.commit()
        with self.assertRaisesRegex(RuntimeError, "no source row"):
            self.migrate()
        self.assertTrue(sa.inspect(self.engine).has_table("work_item"))
        with Session(self.engine) as session:
            self.assertIsNone(session.get(models.Task, "one"))
            self.assertEqual(session.get(models.Attachment, "orphan").storage_key, "keep-this-file")

    def test_destructive_downgrade_is_explicitly_refused(self):
        with self.assertRaisesRegex(RuntimeError, "backup"):
            migration.downgrade()

    def test_cross_scope_merge_refuses_to_widen_original_visibility(self):
        self.old_row("one", delivery_task_id="delivery", org_id="org-a")
        self.old_row("two", delivery_task_id="delivery", org_id="org-b")
        with self.assertRaisesRegex(RuntimeError, "different visibility scopes"):
            self.migrate()
        self.assertTrue(sa.inspect(self.engine).has_table("work_item"))
        with Session(self.engine) as session:
            self.assertIsNone(session.get(models.Task, "delivery").shared_org_id)


if __name__ == "__main__":
    unittest.main()
