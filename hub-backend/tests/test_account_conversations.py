"""Integration checks for the account conversation checkpoint contract."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import account_conversation_models  # noqa: F401
from app.account_conversation_models import (
    AccountConversation,
    AccountConversationCursor,
    AccountConversationMessage,
)
from app.api import account_conversations
from app.db import Base, get_session
from app.deps import current_client
from app.models import Client, Task


class AccountConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(
                sync,
                tables=[
                    Client.__table__, AccountConversationCursor.__table__,
                    AccountConversation.__table__, AccountConversationMessage.__table__,
                    Task.__table__,
                ],
            ))
        self.client = Client(
            id="desktop-1", name="desktop", user_ref="user-1", auth_state="active",
        )
        async with self.sessions() as session:
            session.add(self.client)
            await session.commit()

        app = FastAPI()
        app.include_router(account_conversations.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override():
            return self.client

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test",
        )

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    @staticmethod
    def checkpoint(revision, messages, **extra):
        return {
            "sourceClientId": "desktop-1",
            "sourceSessionId": "native-1",
            "sourceEpoch": "native-1:desktop",
            "sourceRevision": revision,
            "title": "test",
            "state": "idle",
            "messages": messages,
            "snapshotComplete": True,
            **extra,
        }

    async def test_complete_checkpoint_tombstones_messages_missing_from_source(self):
        first = self.checkpoint(1, [
            {"id": "m1", "position": 0, "role": "user", "text": "hello",
             "createdAt": "2026-11-01T00:00:00Z", "done": True},
            {"id": "m2", "position": 1, "role": "assistant", "text": "reply",
             "createdAt": "2026-11-01T00:00:01Z", "done": True},
        ])
        second = self.checkpoint(2, [first["messages"][0]])
        with patch.object(account_conversations, "_publish_account_update", new=AsyncMock()):
            self.assertEqual((await self.http.post(
                "/api/v1/account-conversations/sync", json=first)).status_code, 200)
            self.assertEqual((await self.http.post(
                "/api/v1/account-conversations/sync", json=second)).status_code, 200)

        data = await self.http.get(
            "/api/v1/account-conversations",
            params={"limit": 100},
        )
        self.assertEqual(data.status_code, 200)
        self.assertEqual(data.json()["items"][0]["messageCount"], 1)
        conversation_id = data.json()["items"][0]["id"]
        transcript = await self.http.get(
            f"/api/v1/account-conversations/{conversation_id}/messages",
            params={"limit": 100},
        )
        self.assertEqual(transcript.status_code, 200)
        rows = {row["id"]: row for row in transcript.json()["items"]}
        self.assertFalse(rows["m1"]["deleted"])
        self.assertTrue(rows["m2"]["deleted"])

    async def test_task_projection_identity_is_authorized_and_backward_compatible(self):
        async with self.sessions() as session:
            session.add_all([
                Task(id="mine", title="same title", owner_client_id="desktop-1",
                     owner_user_id="user-1", created_by="user-1"),
                Task(id="other", title="same title", owner_client_id="desktop-2",
                     owner_user_id="user-2", created_by="user-2"),
            ])
            await session.commit()
        with patch.object(account_conversations, "_publish_account_update", new=AsyncMock()):
            denied = await self.http.post("/api/v1/account-conversations/sync",
                json=self.checkpoint(1, [], taskProjectionId="other"))
            self.assertEqual(denied.status_code, 404)
            payload = self.checkpoint(1, [], taskProjectionId="mine")
            for _ in range(2):
                self.assertEqual((await self.http.post(
                    "/api/v1/account-conversations/sync", json=payload)).status_code, 200)
            # Older clients omit this field rather than erasing the binding.
            self.assertEqual((await self.http.post("/api/v1/account-conversations/sync",
                json=self.checkpoint(2, []))).status_code, 200)
        data = (await self.http.get("/api/v1/account-conversations")).json()
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["items"][0]["taskProjectionId"], "mine")
        self.assertEqual(data["items"][0]["messageCount"], 0)


if __name__ == "__main__":
    unittest.main()
