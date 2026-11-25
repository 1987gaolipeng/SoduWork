"""Private migrated databases and authenticated fixtures for handoff tests."""
import atexit
import asyncio
from functools import cache
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine

# Standalone test entry points must also import the Hub against a safe default.
_TEST_SECRET = "handoff-target-test-secret-not-a-real-credential"
_TEST_PASSWORD = "handoff-fixture-password"
with patch.dict(os.environ, DATABASE_URL=os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///:memory:"),
                AUTH_SECRET=os.environ.get("AUTH_SECRET") or _TEST_SECRET,
                ADMIN_PASS=os.environ.get("ADMIN_PASS") or _TEST_PASSWORD):
    from app import db, models
from app.api import conversation_handoffs as api
from app.automation_models import RunnerNode
from app.services import device_auth, runner_hub


@cache
def _migrated_schema():
    directory = tempfile.TemporaryDirectory(prefix="soduwork-handoff-schema-")
    atexit.register(directory.cleanup)
    template = Path(directory.name) / "test.db"
    env = dict(os.environ, DATABASE_URL="sqlite+aiosqlite:///" + template.as_posix(),
               AUTH_SECRET=_TEST_SECRET,
               ADMIN_PASS=_TEST_PASSWORD, SODUWORK_DATA_ROOT=directory.name)
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"],
                   cwd=Path(__file__).parent, env=env, check=True)
    return template


async def setup_handoff_database(test):
    temp = tempfile.TemporaryDirectory(prefix="soduwork-handoff-test-")
    test.addCleanup(temp.cleanup)
    test.work = Path(temp.name)
    database = test.work / "test.db"
    shutil.copyfile(await asyncio.to_thread(_migrated_schema), database)
    engine = create_async_engine("sqlite+aiosqlite:///" + database.as_posix())
    test.addAsyncCleanup(engine.dispose)
    # Existing services import the same session factory; keep those references
    # bound to the private database and restore the binding after every test.
    test.enterContext(patch.dict(db.SessionLocal.kw, bind=engine))
    test.enterContext(patch.multiple(db.settings, auth_secret=_TEST_SECRET, device_auth_compat=False, minio_endpoint="",
                                     cluster_redis_url="",
                                     cloud_execution_runner_ids="", hub_local_execution_enabled=True))
    test.enterContext(patch.dict(os.environ, SODUWORK_DATA_ROOT=str(test.work / "data")))
    test.enterContext(patch.dict(runner_hub._RUNNERS, clear=True))


class HandoffFixture:
    async def asyncSetUp(self):
        await setup_handoff_database(self)
        self.prefix = uuid.uuid4().hex[:12]
        self.org = self.prefix + "-org"
        self.foreign_org = self.prefix + "-foreign"
        self.user_id = self.prefix + "-owner"
        self.client_id = self.prefix + "-desktop"
        self.other_id = self.prefix + "-other-own-device"
        self.colleague_id = self.prefix + "-colleague-device"
        self.foreign_client_id = self.prefix + "-foreign-device"
        async with db.SessionLocal() as session:
            user = models.User(id=self.user_id, username=self.user_id, org_id=self.org, is_active=True)
            client = models.Client(id=self.client_id, user_ref=user.id, auth_state="active")
            session.add_all([
                models.OrgUnit(id=self.org, name="Target test team"),
                models.OrgUnit(id=self.foreign_org, name="Other test organization"), user, client,
                models.User(id=self.prefix + "-colleague", username=self.prefix + "-colleague",
                            org_id=self.org, is_active=True),
                models.User(id=self.prefix + "-foreign-owner", username=self.prefix + "-foreign-owner",
                            org_id=self.foreign_org, is_active=True),
                models.Client(id=self.other_id, user_ref=user.id, auth_state="active"),
                models.Client(id=self.colleague_id, user_ref=self.prefix + "-colleague", auth_state="active"),
                models.Client(id=self.foreign_client_id, user_ref=self.prefix + "-foreign-owner", auth_state="active"),
            ])
            await session.commit()
        token = device_auth.issue_session(client)[0]
        self.app = FastAPI()
        self.app.include_router(api.router)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated",
                                     headers={"Authorization": "Device " + token})

        self.addAsyncCleanup(self.http.aclose)

    def live(self, name, *, client_id="", org_id=None):
        rid = self.prefix + "-" + name
        node = runner_hub._Runner(None, {
            "runnerId": rid, "host": name, "workRoot": str(self.work / "remote-work"),
            "agents": [{"key": "codex", "auth": "authed"}], "caps": ["handoff1"],
            "capabilities": {"available": ["files", "terminal"]},
        })
        node.client_id, node.org_id = client_id, self.org if org_id is None else org_id
        node.ready, node.inventory_ready, node.dispatch_mode = True, True, "accepting"
        node.alive = lambda: True
        runner_hub._RUNNERS[rid] = node
        return node

    async def catalog(self):
        reply = await self.http.get("/api/v1/conversation-handoffs/targets")
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    async def enroll_personal(self, node):
        node.owner_user_id = self.user_id
        async with db.SessionLocal() as session:
            session.add(RunnerNode(id=node.id, org_id=self.org, owner_user_id=self.user_id))
            await session.commit()
