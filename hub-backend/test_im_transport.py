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
from fastapi import FastAPI
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


class IMTransportTests(IMFixture, unittest.IsolatedAsyncioTestCase):
    async def test_telegram_full_path_dedup_serial_execution_and_reply(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        for text, event_id in [("整理报告", 2), ("整理报告", 2), ("继续检查", 3)]:
            self.assertEqual((await self.incoming(identifier, credentials, text, event_id)).status_code, 200)
        await im_worker.run_once(self.sessions)
        self.assertEqual([item[1] for item in self.submitted], ["整理报告"])
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(ConversationMessageReceipt)), 1)
        await self.ready()
        await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.submitted), 1)
        await self.complete()
        await self.ready()
        await im_worker.run_once(self.sessions)
        await self.ready()
        await im_worker.run_once(self.sessions)
        self.assertEqual([item[1] for item in self.submitted], ["整理报告", "继续检查"])
        for _ in range(4):
            await self.ready(); await im_worker.run_once(self.sessions)
        self.assertTrue(any("结果正确" in message.get("text", "") for message in self.sent), self.sent)
        self.assertTrue(all(message.get("chat_id") == "42" for message in self.sent))


    async def test_feishu_encrypted_messages_signature_and_external_scope(self):
        identifier, credentials = await self.connection("feishu")
        await self.pair(identifier, credentials, provider="feishu")
        self.assertEqual((await self.incoming(identifier, credentials, "执行", 2, provider="feishu", tamper=True)).status_code, 401)
        self.assertEqual((await self.incoming(identifier, credentials, "执行", 2, provider="feishu", age=301)).status_code, 401)
        for fields in ({"sender": "43"}, {"tenant": "foreign-tenant"}, {"chat": "43"}):
            self.assertEqual((await self.incoming(identifier, credentials, "不能执行", 2, provider="feishu", **fields)).status_code, 200)
        self.assertEqual((await self.incoming(identifier, credentials, "执行", 3, provider="feishu", encrypt=True)).status_code, 200)
        await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.submitted), 1)
        await self.complete("飞书文字结果")
        await self.ready(); await im_worker.run_once(self.sessions)
        await self.ready(); await im_worker.run_once(self.sessions)
        await self.ready(); await im_worker.run_once(self.sessions)
        self.assertTrue(any("飞书文字结果" in message.get("content", "") for message in self.sent), self.sent)
        self.assertTrue(all("uuid" in message for message in self.sent))


    async def test_concurrent_callbacks_and_workers_preserve_one_execution(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        replies = await asyncio.gather(*(self.incoming(identifier, credentials, "only once", 2) for _ in range(4)))
        self.assertEqual([reply.status_code for reply in replies], [200] * 4)
        await asyncio.gather(*(im_worker.process_route(self.sessions, self.task.id) for _ in range(4)))
        self.assertEqual(len(self.submitted), 1)
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(im.IMInbox)), 2)
            self.assertEqual(await session.scalar(select(func.count()).select_from(ConversationMessageReceipt)), 1)


    async def test_explicit_desktop_start_uses_core_dispatch_and_returns_first_round(self):
        async with self.sessions() as session:
            await session.execute(delete(models.TaskEvent))
            await session.execute(delete(am.ExecutionSession))
            task = await session.get(models.Task, self.task.id)
            task.status = "todo"
            node = await session.get(am.RunnerNode, self.node.id)
            node.agents = [{"key": "codex", "name": "Codex", "installed": True}]
            node.tags = [runner_hub.CLIENT_TAG]
            await session.commit()
        self.live = runner_hub._Runner(None, {"runnerId": self.node.id, "clientId": self.client.id,
            "host": "fixture-desktop", "tags": [runner_hub.CLIENT_TAG],
            "agents": [{"key": "codex", "name": "Codex", "installed": True}]})
        self.live.org_id, self.live.dispatch_mode = "im-org", "accepting"
        self.live.ready = True
        identifier, credentials = await self.connection()
        targets = (await self.request("GET", "/connections/" + identifier + "/targets")).json()["targets"]
        selected = next(row for row in targets if row["taskId"] == self.task.id)
        self.assertEqual(selected["runnerKind"], "desktop")
        self.assertFalse(selected["started"])
        self.assertEqual(selected["agents"][0]["id"], "codex")
        rejected = await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})
        self.assertEqual(rejected.status_code, 409)
        granted = await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id, "allowStart": True, "agentId": "codex"})
        self.assertEqual(granted.status_code, 200, granted.text)
        await self.incoming(identifier, credentials, granted.json()["command"], 1)
        await self.incoming(identifier, credentials, "start on my desktop", 2)
        def launch(ctx, task, files, selected_agent, extra):
            self.assertEqual(task.id, self.task.id)
            self.assertEqual(selected_agent["id"], "runner:im-runner:codex")
            self.assertEqual(extra["brief"], "start on my desktop")
            return {"ok": True, "issueId": "runner:im-ref", "runnerId": self.node.id,
                "runnerClientId": self.client.id, "assigneeId": selected_agent["id"], "assigneeCli": "codex", "provider": "runner",
                "admissionKey": "dispatch:runner:im-ref"}
        with patch.object(runner_hub, "dispatchable", return_value=[self.live]), \
                patch.object(runner_hub, "online", return_value=[self.live]), \
                patch.object(ai_exec, "dispatch_sync", side_effect=launch) as launched:
            await im_worker.run_once(self.sessions)
            self.assertEqual(launched.call_count, 1)
        async with self.sessions() as session:
            row = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(row.status, "waiting", row.detail)
            self.assertEqual(row.base_round, 0)
            self.assertIsNotNone(await ai_exec.last_dispatch_event(session, self.task.id))
        await self.complete("首次桌面任务完成", round_no=1)
        for _ in range(4):
            await self.ready(); await im_worker.run_once(self.sessions)
        self.assertTrue(any("首次桌面任务完成" in item["text"] for item in self.sent), self.sent)


    async def test_stale_snapshot_and_interleaved_desktop_turn_never_reply_with_other_output(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, "IM exact turn", 2)
        await im_worker.run_once(self.sessions)
        await self.complete("PRIVATE DESKTOP ANSWER", round_no=2, admission_key="comment:desktop-other-turn")
        await self.ready(); await im_worker.run_once(self.sessions)
        async with self.sessions() as session:
            item = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(item.status, "waiting")
        self.assertFalse(any("PRIVATE DESKTOP" in item.get("text", "") for item in self.sent))
        await self.complete("IM correct answer", round_no=3)
        for _ in range(4):
            await self.ready(); await im_worker.run_once(self.sessions)
        self.assertTrue(any("IM correct answer" in item.get("text", "") for item in self.sent))
        self.assertFalse(any("PRIVATE DESKTOP" in item.get("text", "") for item in self.sent))


    async def test_old_runner_receipt_and_prelaunch_failure_have_visible_fenced_outcomes(self):
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, "old runner", 2)
        with patch.object(ai_exec, "say_sync", return_value={"ok": True, "queued": True}):
            await im_worker.run_once(self.sessions)
        async with self.sessions() as session:
            old = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(old.status, "uncertain")
            self.assertIn("升级", old.detail)
        await self.request("POST", "/messages/" + old.id + "/dismiss")
        await self.incoming(identifier, credentials, "fails after admission", 3)
        await self.ready(); await im_worker.run_once(self.sessions)
        async with self.sessions() as session:
            item = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "3"))).one()
            item.accepted_at = connections.now() - timedelta(minutes=2)
            await session.commit()
        self.live.call = AsyncMock(return_value={"ok": True, "data": {"ok": True, "state": "failed", "admissionKey": item.admission_key}})
        await self.ready(); await im_worker.run_once(self.sessions)
        async with self.sessions() as session:
            self.assertEqual((await session.get(im.IMInbox, item.id)).status, "rejected")
        self.live.call.assert_awaited_once()


    async def test_wecom_encrypted_callback_verification_identity_and_final_reply(self):
        identifier, credentials = await self.connection("wecom")
        verified = await self.enterprise_incoming(identifier, credentials, "", 0, "wecom", challenge=True)
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.text, "challenge-ok")
        code = (await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})).json()["command"]
        self.assertEqual((await self.enterprise_incoming(identifier, credentials, code, 1, "wecom")).status_code, 200)
        for options in ({"tamper": True}, {"tenant": "wwforeign"}, {"timestamp": int(time.time()) - 301}):
            self.assertEqual((await self.enterprise_incoming(identifier, credentials, "forged", 2, "wecom", **options)).status_code, 401)
        self.assertEqual((await self.enterprise_incoming(identifier, credentials, "do work", 2, "wecom")).status_code, 200)
        await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.submitted), 1)
        await self.complete("企微文字结果")
        for _ in range(4):
            await self.ready(); await im_worker.run_once(self.sessions)
        self.assertTrue(any("企微文字结果" in item.get("text", {}).get("content", "") for item in self.sent))
        self.assertTrue(all(item.get("touser") == "fixture-user" for item in self.sent))
        self.assertEqual((await self.enterprise_incoming(identifier, credentials, "next work", 3, "wecom")).status_code, 200)
        for _ in range(2):
            await self.ready(); await im_worker.run_once(self.sessions)
        acknowledgements = [item for item in self.sent if item.get("text", {}).get("content", "").startswith("已收到")]
        self.assertEqual(len(acknowledgements), 2)
        self.assertTrue(all(item.get("enable_duplicate_check") == 0 for item in acknowledgements))


    async def test_dingtalk_signed_callback_replay_binding_and_proactive_final_reply(self):
        identifier, credentials = await self.connection("dingtalk")
        code = (await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})).json()["command"]
        self.assertEqual((await self.enterprise_incoming(identifier, credentials, code, 1, "dingtalk")).status_code, 200)
        for options in ({"tamper": True}, {"tenant": "dingforeign"}, {"timestamp": int(time.time() * 1000) - 301000}):
            self.assertEqual((await self.enterprise_incoming(identifier, credentials, "forged", 2, "dingtalk", **options)).status_code, 401)
        stamp = int(time.time() * 1000) + 100
        self.assertEqual((await self.enterprise_incoming(identifier, credentials, "do work", 2, "dingtalk", timestamp=stamp)).status_code, 200)
        self.assertEqual((await self.enterprise_incoming(identifier, credentials, "tampered payload", 3, "dingtalk", timestamp=stamp)).status_code, 409)
        await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.submitted), 1)
        await self.complete("钉钉文字结果")
        for _ in range(4):
            await self.ready(); await im_worker.run_once(self.sessions)
        self.assertTrue(any("钉钉文字结果" in item.get("msgParam", "") for item in self.sent))
        self.assertTrue(all(item.get("userIds") == ["fixture-staff"] for item in self.sent))



if __name__ == "__main__":
    unittest.main()
