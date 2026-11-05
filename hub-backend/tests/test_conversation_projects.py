"""Project membership follows account identities without copying chat content."""
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.account_conversation_models import AccountConversation, ConversationProject
from app.api import conversation_projects
from app.db import Base, get_session
from app.deps import current_client
from app.models import Client
from app.services import client_domain_events


class ConversationProjectsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await client_domain_events.stop()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=[
                AccountConversation.__table__, ConversationProject.__table__, Client.__table__]))
        async with self.sessions() as session:
            session.add_all([Client(id="pc", user_ref="alice", auth_state="active"),
                             Client(id="phone", user_ref="alice", auth_state="active"),
                             Client(id="other", user_ref="bob", auth_state="active")])
            await session.commit()
        app = FastAPI()
        app.include_router(conversation_projects.router)

        async def session():
            async with self.sessions() as value:
                yield value

        async def client(request: Request):
            return Client(id=request.headers.get("device", "pc"),
                          user_ref=request.headers.get("owner", "alice"))

        app.dependency_overrides[get_session] = session
        app.dependency_overrides[current_client] = client
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await client_domain_events.stop()
        await self.http.aclose()
        await self.engine.dispose()

    async def test_committed_edits_wake_only_owner_devices_and_conflicts_do_not_publish(self):
        with patch("app.services.native_discovery.wake", new_callable=AsyncMock) as wake:
            response = await self.http.put("/api/v1/conversation-projects/project-one",
                                           json={"name": "One", "revision": 0, "chatIds": []})
            self.assertEqual(response.status_code, 200)
            wake.assert_not_awaited()
            await client_domain_events.flush_for_test(self.sessions)
            self.assertEqual(set(response.json()), {"id", "name", "revision", "deleted", "chatIds"})
            self.assertEqual({tuple(call.args) for call in wake.await_args_list},
                             {("pc", "alice", "conversation-projects"),
                              ("phone", "alice", "conversation-projects")})
            wake.reset_mock()
            conflict = await self.http.put("/api/v1/conversation-projects/project-one",
                                           json={"name": "Conflict", "revision": 0})
            self.assertEqual(conflict.status_code, 409)
            await client_domain_events.flush_for_test(self.sessions)
            wake.assert_not_awaited()

    async def test_failed_push_does_not_change_committed_write_response(self):
        with patch("app.services.native_discovery.wake", new_callable=AsyncMock, side_effect=OSError("offline")):
            response = await self.http.put("/api/v1/conversation-projects/project-one",
                                           json={"name": "Saved", "revision": 0, "chatIds": []})
            await client_domain_events.flush_for_test(self.sessions)
        self.assertEqual(response.status_code, 200)
        rows = (await self.http.get("/api/v1/conversation-projects")).json()["items"]
        self.assertEqual(rows[0]["name"], "Saved")

    async def save(self, body, **headers):
        return await self.http.put("/api/v1/conversation-projects/project-one", json=body, headers=headers)

    async def directory(self, **headers):
        return (await self.http.get("/api/v1/conversation-projects", headers=headers)).json()["items"]

    async def test_sync_before_chat_upload_retains_members_and_resolves_after_upload(self):
        made = await self.save({"name": "Project", "revision": 0, "chatIds": ["native"]})
        self.assertEqual(made.status_code, 200, made.text)
        self.assertEqual(made.json()["chatIds"], ["native"])
        phone = (await self.directory(device="phone"))[0]
        self.assertTrue(phone["chatIds"][0].startswith("member:"))
        # A metadata edit never discards the PC's not-yet-uploaded chat.
        renamed = await self.save({"name": "Renamed", "revision": 1}, device="phone")
        self.assertEqual(renamed.status_code, 200, renamed.text)
        async with self.sessions() as session:
            session.add(AccountConversation(id="mirror", owner_user_id="alice", source_client_id="pc",
                                            source_session_id="native"))
            await session.commit()
        self.assertEqual((await self.directory(device="phone"))[0]["chatIds"], ["account:mirror"])
        self.assertEqual((await self.directory())[0]["chatIds"], ["native"])
        removed = await self.save({"name": "Renamed", "revision": 2, "chatIds": []}, device="phone")
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual((await self.directory())[0]["chatIds"], [])

    async def test_revision_conflicts_and_explicit_tombstones_do_not_overwrite(self):
        await self.save({"name": "Original", "revision": 0, "chatIds": ["one"]})
        conflict = await self.save({"name": "Stale", "revision": 0, "chatIds": []}, device="phone")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual((await self.directory())[0]["name"], "Original")
        deleted = await self.save({"name": "Original", "revision": 1, "deleted": True})
        self.assertTrue(deleted.json()["deleted"])
        self.assertEqual(deleted.json()["revision"], 2)
        self.assertEqual((await self.directory(device="phone"))[0]["revision"], 2)

    async def test_another_account_cannot_read_or_retain_foreign_members(self):
        await self.save({"name": "Private", "revision": 0, "chatIds": ["native"]})
        opaque = (await self.directory(device="phone"))[0]["chatIds"][0]
        self.assertEqual(await self.directory(owner="bob"), [])
        denied = await self.save({"name": "Other", "revision": 0, "chatIds": [opaque]}, owner="bob")
        self.assertEqual(denied.status_code, 422)
        async with self.sessions() as session:
            session.add(AccountConversation(id="private", owner_user_id="alice", source_client_id="pc",
                                            source_session_id="native"))
            await session.commit()
        denied = await self.save({"name": "Other", "revision": 0, "chatIds": ["account:private"]}, owner="bob")
        self.assertEqual(denied.status_code, 404)

    async def test_unresolved_members_survive_explicit_membership_edits(self):
        await self.save({"name": "Project", "revision": 0, "chatIds": ["native"]})
        phone = (await self.directory(device="phone"))[0]
        changed = await self.save({"name": "Project", "revision": 1,
                                   "chatIds": phone["chatIds"] + ["task:task-one"]}, device="phone")
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual((await self.directory())[0]["chatIds"], ["native", "cloud-task:task-one"])
