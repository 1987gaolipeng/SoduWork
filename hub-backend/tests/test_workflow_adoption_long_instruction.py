"""Evidence adoption must persist the same complete instruction as a fresh run."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-workflow-adoption-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-workflow-adoption-admin")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models as am
from app.services import workflow_runs


class AdoptionLongInstructionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as connection:
            await connection.run_sync(models.Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.addAsyncCleanup(self.session.close)
        self.task = models.Task(id="task", title="Continue audited work", status="doing")
        self.binding = am.PluginBinding(id="binding", plugin_id="plugin", version_id="version", enabled=True)
        self.source = am.WorkflowRun(id="old-run", task_id="task", plugin_id="plugin", plugin_version_id="old-version", state="failed")
        self.session.add_all([
            self.task, self.binding, self.source,
            am.Plugin(id="plugin", key="adopt-test", name="Adoption test", enabled=True),
            am.PluginVersion(id="version", plugin_id="plugin", version="2", checksum="new",
                             trust_state="approved", enabled=True, manifest={}, workflow={"nodes": [
                {"key": "prepare", "type": "ai"},
                {"key": "publish", "type": "publish", "dependsOn": ["prepare"]},
            ]}),
            am.NodeRun(id="old-node", run_id="old-run", node_key="prepare", node_type="ai",
                       attempt=1, state="succeeded", output={}, idempotency_key="old-node"),
        ])
        await self.session.commit()
        # The fixture has no Runner; only environment readiness is substituted.
        ready = patch.object(workflow_runs, "_ensure_start_ready", AsyncMock(return_value={"ok": True}))
        ready.start()
        self.addCleanup(ready.stop)

    async def start(self, instruction):
        return await workflow_runs.start_from_evidence(
            self.session, self.task, self.binding, {}, self.source, "publish", instruction=instruction)

    async def test_resumed_run_persists_full_instruction_for_later_node_dispatch(self):
        instruction = "完整原文\n" * 5000 + "TAIL: retain this final acceptance condition"
        run = await self.start(instruction)
        run_id = run.id
        self.session.expire_all()
        saved = await self.session.get(am.WorkflowRun, run_id)
        self.assertEqual(saved.context["instruction"], instruction)
        pending = list((await self.session.scalars(select(am.WorkflowOutbox).where(am.WorkflowOutbox.run_id == saved.id))).all())
        self.assertEqual(len(pending), 1)

    async def test_oversized_instruction_is_rejected_before_any_resumed_run_is_saved(self):
        with self.assertRaises(HTTPException) as raised:
            await self.start("x" * 50001)
        self.assertEqual(raised.exception.status_code, 422)
        rows = list((await self.session.scalars(select(am.WorkflowRun))).all())
        self.assertEqual([row.id for row in rows], ["old-run"])
        self.assertEqual(list((await self.session.scalars(select(am.WorkflowOutbox))).all()), [])


if __name__ == "__main__":
    unittest.main()
