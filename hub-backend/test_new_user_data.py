"""New-install bootstrap and task/requirement visibility against an isolated DB.

Run this file directly; no live Hub, real accounts, poller or Runner is used.
"""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ["AUTH_SECRET"] = "isolated-new-user-test-signing-key-not-for-production"
os.environ["ADMIN_PASS"] = "isolated-test-bootstrap-only"

import unittest
import httpx
from sqlalchemy import select, func
from app.main import app
from app import models
from app.db import Base, engine, SessionLocal
from app.services import rbac, work_catalog, device_auth

# Other unittest modules may import and cache app.db before this module sets env.
# Fail before even create_all; teardown must never act on a previously-bound Hub DB.
if engine.url.get_backend_name() != "sqlite" or engine.url.database != ":memory:":
    raise RuntimeError("New-user tests require their own in-memory engine; run this file in an isolated process")

class NewUserDataTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        async with SessionLocal() as session:
            await rbac.bootstrap(session)
            await rbac.seed_positions(session)
            await rbac.seed_domains(session)
            await work_catalog.bootstrap(session)
            a = models.OrgUnit(id="company-a", name="Existing company")
            b = models.OrgUnit(id="company-b", name="New company")
            session.add_all([a,b])
            self.users = [
                models.User(id="old-user",username="old-person",password_hash="test-only",org_id=a.id),
                models.User(id="new-user",username="new-person",password_hash="test-only",org_id=b.id),
                models.User(id="colleague",username="same-company",password_hash="test-only",org_id=a.id),
            ]
            session.add_all(self.users)
            await session.commit()
        self.headers = {}
        for uid in ("old-user","new-user","colleague"):
            device = "device-"+uid
            response = await self.http.post("/api/v1/clients/enroll",
                headers={"X-Device-Key":"isolated-enrollment-key-"+uid+"-12345678901234567890"},
                json={"device":device,"name":"Isolated installation"})
            self.assertEqual(response.status_code,200,response.text)
            async with SessionLocal() as session:
                client = await session.get(models.Client,device)
                user = await session.get(models.User,uid)
                device_auth.activate(client,user)
                await session.commit()
                token,_ = device_auth.issue_session(client)
                self.headers[uid]={"Authorization":"Device "+token,"X-Soduwork-Device":device}

    async def asyncTearDown(self):
        await self.http.aclose()
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()

    async def counts(self):
        async with SessionLocal() as session:
            return [await session.scalar(select(func.count()).select_from(cls))
                    for cls in (models.Task,)]

    async def fetch(self,path,user="new-user"):
        response=await self.http.get("/api/v1/"+path,headers=self.headers[user])
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    async def add_existing(self):
        async with SessionLocal() as session:
            session.add(models.Task(id="existing-task",owner_client_id="device-old-user",
                title="Existing real task",created_by="old-user"))
            session.add(models.Task(id="existing-requirement",shared_org_id="company-a",
                owner_client_id="device-old-user",created_by="old-user",
                title="Existing shared requirement",note="Real business data"))
            await session.commit()

    async def test_bootstrap_enroll_activate_and_repeated_reads_never_seed_work(self):
        self.assertEqual(await self.counts(),[0])
        for _ in range(2):
            self.assertEqual(await self.fetch("tasks"),[])
        self.assertEqual(await self.counts(),[0])

    async def test_unrelated_new_user_gets_no_other_company_tasks_or_requirements(self):
        await self.add_existing()
        self.assertEqual(await self.fetch("tasks"),[])
        self.assertEqual(await self.counts(),[2])

    async def test_company_shared_requirements_remain_visible_but_not_personal_tasks(self):
        await self.add_existing()
        result=await self.fetch("tasks","colleague")
        self.assertEqual([row["id"] for row in result],["existing-requirement"])
        self.assertFalse(result[0]["canViewExecution"])

    async def test_new_user_receives_only_explicitly_assigned_task_with_materials(self):
        await self.add_existing()
        async with SessionLocal() as session:
            session.add(models.Task(id="assigned-task",owner_client_id="device-new-user",
                title="写周报",note="Keep the original task description",created_by="old-user",
                assignee_user_id="new-user"))
            await session.commit()
        rows=await self.fetch("tasks")
        self.assertEqual([row["id"] for row in rows],["assigned-task"])
        self.assertEqual(rows[0]["note"],"Keep the original task description")
        self.assertEqual(await self.counts(),[3])

if __name__=="__main__":
    unittest.main(verbosity=2)
