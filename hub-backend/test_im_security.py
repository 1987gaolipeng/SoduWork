"""Isolated IM callbacks traverse real auth, queues, message receipts and final replies."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import tempfile
import time
import struct
from xml.sax.saxutils import escape
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-im-transport-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-im-transport-admin")

import httpx
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi import FastAPI, HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, im_models as im, models
from app import library_models, memory_record_models, project_context_models, session_memory_models  # noqa: F401
from app.api import im as api
from app.config import get_settings
from app.conversation_handoff_models import ConversationMessageReceipt
from app.db import Base, get_session
from app.services import (ai_exec, client_access, device_auth, execution_sessions,
    im_adapters, im_connections as connections, im_transport, im_worker, runner_hub)


from im_test_support import IMFixture


class IMSecurityTests(IMFixture, unittest.IsolatedAsyncioTestCase):
    async def test_first_start_cannot_adopt_a_concurrent_desktop_dispatch_receipt(self):
        from app.services import im_execution
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, "my first request", 2)
        with patch.object(im_execution, "preflight", return_value=(self.client, None, "")), patch.object(
                im_execution, "submit", return_value={"ok": True, "already": True, "issueId": "other-desktop-run",
                    "admissionKey": "dispatch:other-desktop-run", "turnCorrelationVersion": 1}) as submit:
            await im_worker.run_once(self.sessions)
            self.assertEqual(submit.await_count, 1)
        async with self.sessions() as session:
            inbox = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(inbox.status, "rejected")
            self.assertEqual(inbox.admission_key, "")
            self.assertIn("另一条请求", inbox.detail)
            self.assertFalse((await session.get(im.IMRoute, self.task.id)).active_inbox_id)

    async def test_invalid_provider_is_rejected_and_setup_outage_keeps_revocation_available(self):
        for provider in ([], {}, 7, None):
            result = await self.request("POST", "/connections", json={"provider": provider, "credentials": {}})
            self.assertEqual(result.status_code, 400)
        identifier, credentials = await self.connection()
        with patch.object(connections, "callback", side_effect=HTTPException(503, "fixture public URL unavailable")):
            catalog = await self.request("GET", "")
            self.assertEqual(catalog.status_code, 200)
            self.assertEqual(catalog.json()["connections"][0]["webhookUrl"], "")
            created = await self.request("POST", "/connections", json={"provider": "telegram",
                "credentials": {"bot_token": credentials["bot_token"]}})
            self.assertEqual(created.status_code, 503)
            self.assertEqual((await self.request("DELETE", "/connections/" + identifier)).status_code, 200)

    async def test_pairing_is_hashed_expiring_single_use_and_owner_scoped(self):
        identifier, credentials = await self.connection()
        bad = await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": "im-foreign-task", "runnerId": self.node.id})
        self.assertEqual(bad.status_code, 403)
        bad = await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": "im-foreign-runner"})
        self.assertEqual(bad.status_code, 403)
        bad = await self.request("GET", "/connections/" + identifier + "/targets",
            headers={"Authorization": "Device " + device_auth.issue_session(self.other_client)[0]})
        self.assertEqual(bad.status_code, 404)
        binding, command = await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, command, 2, sender="43", chat="43")
        async with self.sessions() as session:
            grants = list((await session.scalars(select(im.IMPairing))).all())
            self.assertEqual(len(grants[0].code_hash), 64)
            self.assertIsNotNone(grants[0].used_at)
            self.assertEqual(await session.scalar(select(func.count()).select_from(im.IMBinding)), 1)
        reply = await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})
        async with self.sessions() as session:
            await session.execute(update(im.IMPairing).values(expires_at=connections.now() - timedelta(seconds=1)))
            await session.commit()
        await self.incoming(identifier, credentials, reply.json()["command"], 3, sender="44", chat="44")
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(im.IMBinding)), 1)


    async def test_offline_queue_resumes_but_revocation_blocks_pending_work_and_reply(self):
        identifier, credentials = await self.connection()
        binding, _ = await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, "离线排队", 2)
        self.live = None
        await im_worker.run_once(self.sessions)
        self.assertFalse(self.submitted)
        async with self.sessions() as session:
            item = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(item.status, "queued")
            self.assertIn("离线", item.detail)
        self.live = SimpleNamespace(id=self.node.id, client_id=self.client.id, org_id="im-org", owner_user_id="", host="fixture")
        await self.ready(); await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.submitted), 1)
        await self.request("DELETE", "/bindings/" + binding)
        await self.complete()
        before = len(self.sent)
        await self.ready(); await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.sent), before)


    async def test_uncertain_rpc_is_never_replayed_and_recovered_lease_is_fenced(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, "执行一次", 2)
        with patch.object(ai_exec, "say_sync", return_value={"ok": False, "uncertain": True}) as say:
            await im_worker.run_once(self.sessions)
            await self.ready(); await im_worker.run_once(self.sessions)
            self.assertEqual(say.call_count, 1)
        async with self.sessions() as session:
            item = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(item.status, "uncertain")
            identifier_in = item.id
        dismissed = await self.request("POST", "/messages/" + identifier_in + "/dismiss")
        self.assertEqual(dismissed.json(), {"ok": True, "resent": False})
        await self.incoming(identifier, credentials, "模拟崩溃", 3)
        async with self.sessions() as session:
            item = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "3"))).one()
            item.status = "sending"
            route = await session.get(im.IMRoute, self.task.id)
            route.active_inbox_id, route.lease_until = item.id, connections.now() - timedelta(seconds=1)
            await session.commit()
        await self.ready(); await im_worker.run_once(self.sessions)
        self.assertFalse(self.submitted)
        async with self.sessions() as session:
            self.assertEqual((await session.get(im.IMInbox, item.id)).status, "uncertain")


    async def test_provider_send_timeout_is_visible_and_not_retried(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        self.send_failure = "timeout"
        await im_worker.run_once(self.sessions)
        await self.ready(); await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.sent), 1)
        async with self.sessions() as session:
            row = (await session.scalars(select(im.IMOutbox))).one()
            self.assertEqual(row.status, "uncertain")
            self.assertNotIn("fixture-secret", row.detail)


    async def test_user_revocation_and_approval_are_rechecked_at_execution(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, "受审批保护", 2)
        async with self.sessions() as session:
            session.add(am.ApprovalRequest(id="im-approval", task_id=self.task.id, artifact_version_id="fixture-artifact",
                action="review", status="pending"))
            await session.commit()
        await im_worker.run_once(self.sessions)
        self.assertFalse(self.submitted)
        async with self.sessions() as session:
            row = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(row.status, "rejected")
            self.assertIn("审批", row.detail)
            owner = await session.get(models.User, self.owner.id)
            owner.auth_version += 1
            await session.commit()
        before = len(self.sent)
        await self.ready(); await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.sent), before)
        self.assertEqual((await self.incoming(identifier, credentials, "已撤销", 3)).status_code, 403)


    async def test_disabled_bad_secret_replay_conflict_and_payload_limits(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        self.assertEqual((await self.incoming(identifier, credentials, "wrong secret", 2, tamper=True)).status_code, 401)
        self.assertEqual((await self.incoming(identifier, credentials, "first", 2)).status_code, 200)
        self.assertEqual((await self.incoming(identifier, credentials, "changed", 2)).status_code, 409)
        self.assertEqual((await self.incoming(identifier, credentials, "stale", 3, age=86401)).status_code, 401)
        large = await self.request("POST", "/webhooks/" + identifier, content=b"x" * (im_adapters.MAX_BODY + 1))
        self.assertEqual(large.status_code, 413)
        with patch.object(get_settings(), "im_enabled", False):
            self.assertEqual((await self.incoming(identifier, credentials, "disabled", 4)).status_code, 503)
            await im_worker.run_once(self.sessions)
            self.assertFalse(self.submitted)
        view = (await self.request("GET", "")).text
        self.assertNotIn(credentials["bot_token"], view)
        self.assertNotIn(credentials["webhook_secret"], view)


    async def test_rate_limit_keeps_later_replies_ordered_and_quota_blocks_execution(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, "quota protected", 2)
        self.send_failure = "rate"
        with patch.object(client_access, "assert_quota", side_effect=client_access.ClientAccessError("quota", code="QUOTA", status=403)):
            await im_worker.run_once(self.sessions)
        self.assertFalse(self.submitted)
        async with self.sessions() as session:
            row = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(row.status, "rejected")
        self.send_failure = ""
        await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.sent), 1)
        for _ in range(3):
            await self.ready(); await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.sent), 4)
        self.assertIn("绑定", self.sent[1]["text"])
        self.assertIn("额度", self.sent[-1]["text"])



if __name__ == "__main__":
    unittest.main()
