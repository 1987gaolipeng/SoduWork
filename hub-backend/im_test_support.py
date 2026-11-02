"""Shared isolated database and fake platform/Runner fixtures for IM tests."""
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
from sqlalchemy import create_engine, delete, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, im_models as im, models
from app import library_models, memory_record_models, project_context_models, session_memory_models  # noqa: F401
from app.api import im as api
from app.config import get_settings
from app.conversation_handoff_models import ConversationMessageReceipt
from app.db import Base, get_session
from app.services import (ai_exec, client_access, device_auth, execution_sessions,
    im_adapters, im_connections as connections, im_transport, im_worker, runner_hub)


class IMFixture:
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-im-test-")
        self.addCleanup(self.temp.cleanup)
        database = (Path(self.temp.name) / "test.db").as_posix()
        # Keep the complete private schema while avoiding hundreds of async
        # DDL thread handoffs under unittest's debug event loop on Windows.
        schema_engine = create_engine("sqlite:///" + database)
        try:
            Base.metadata.create_all(schema_engine)
        finally:
            schema_engine.dispose()
        self.engine = create_async_engine("sqlite+aiosqlite:///" + database)
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        settings = get_settings()
        for name, value in (("im_enabled", True), ("connector_oauth_key", base64.urlsafe_b64encode(b"f" * 32).decode()),
                            ("hub_public_url", "https://hub.example.test")):
            guard = patch.object(settings, name, value)
            guard.start(); self.addCleanup(guard.stop)
        client_access._policy_cache = None
        async with self.sessions() as session:
            self.owner = models.User(id="im-owner", username="im-owner", is_active=True, org_id="im-org")
            self.other = models.User(id="im-other", username="im-other", is_active=True, org_id="im-org")
            self.client = models.Client(id="im-desktop", user_ref=self.owner.id, auth_state="active")
            self.other_client = models.Client(id="im-other-device", user_ref=self.other.id, auth_state="active")
            self.task = models.Task(id="im-task", title="IM fixture task", owner_client_id=self.client.id,
                status="doing", origin="local", created_by=self.owner.id)
            self.node = am.RunnerNode(id="im-runner", client_id=self.client.id, org_id="im-org", host="fixture-desktop")
            session.add_all([models.OrgUnit(id="im-org", name="Fixture"), self.owner, self.other,
                self.client, self.other_client, self.task, self.node,
                models.Task(id="im-foreign-task", title="Other task", owner_client_id=self.other_client.id),
                am.RunnerNode(id="im-foreign-runner", client_id=self.other_client.id, org_id="im-org"),
                models.TaskEvent(task_id=self.task.id, kind=ai_exec.EV_DISPATCHED,
                    detail={"ref": "runner:im-ref", "runnerId": self.node.id}),
                am.ExecutionSession(id="im-session", task_id=self.task.id, ref="runner:im-ref", runner_id=self.node.id,
                    runner_client_id=self.client.id, engine="pi", model="im-fixture-model",
                    state="done", seq=1, metadata_={"round": 1})])
            await session.commit()
        self.live = SimpleNamespace(id=self.node.id, client_id=self.client.id, org_id="im-org", owner_user_id="", host="fixture-desktop")
        guard = patch.object(runner_hub, "get", side_effect=lambda key: self.live if key == self.node.id else None)
        guard.start(); self.addCleanup(guard.stop)
        self.app = FastAPI()
        self.app.include_router(api.router)
        async def dependency():
            async with self.sessions() as session:
                yield session
        self.app.dependency_overrides[get_session] = dependency
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://fixture",
            headers={"Authorization": "Device " + device_auth.issue_session(self.client)[0]})
        self.addAsyncCleanup(self.http.aclose)
        original_http = httpx.AsyncClient
        self.sent, self.platform_calls, self.send_failure = [], [], ""
        def platform(request):
            payload = json.loads(request.content) if request.content else {}
            self.platform_calls.append(request.url.path)
            if request.url.path.endswith("/getMe"):
                value = {"ok": True, "result": {"id": 123456789, "is_bot": True, "username": "FixtureBot"}}
            elif request.url.path.endswith("/setWebhook"):
                self.assertTrue(payload["url"].startswith("https://hub.example.test/api/v1/im/webhooks/"))
                self.assertGreater(len(payload["secret_token"]), 30)
                value = {"ok": True, "result": True}
            elif request.url.path.endswith("/tenant_access_token/internal"):
                value = {"code": 0, "tenant_access_token": "fixture-tenant-access", "expire": 7200}
            elif request.url.path.endswith("/bot/v3/info"):
                value = {"code": 0, "bot": {"open_id": "ou_fixture_bot", "activate_status": 2}}
            elif request.url.path.endswith("/gettoken"):
                value = {"errcode": 0, "access_token": "fixture-wecom-access", "expires_in": 7200}
            elif request.url.path.endswith("/agent/get"):
                value = {"errcode": 0, "agentid": 1000001}
            elif request.url.path.endswith("/oauth2/accessToken"):
                value = {"accessToken": "fixture-ding-access", "expireIn": 7200}
            else:
                self.sent.append(payload)
                if self.send_failure == "timeout":
                    raise httpx.ReadTimeout("fixture-secret-must-not-leak", request=request)
                if self.send_failure == "rate":
                    return httpx.Response(429, headers={"Retry-After": "7"}, json={"ok": False})
                value = {"api.telegram.org": {"ok": True, "result": {"message_id": len(self.sent)}},
                    "qyapi.weixin.qq.com": {"errcode": 0, "msgid": "wecom-" + str(len(self.sent))},
                    "api.dingtalk.com": {"processQueryKey": "ding-" + str(len(self.sent))}}.get(request.url.host,
                        {"code": 0, "data": {"message_id": "om_" + str(len(self.sent))}})
            return httpx.Response(200, json=value)
        guard = patch.object(im_transport.httpx, "AsyncClient", side_effect=lambda **kwargs:
            original_http(transport=httpx.MockTransport(platform), **kwargs))
        guard.start(); self.addCleanup(guard.stop)
        self.submitted = []
        def say(ctx, ref, text, **kwargs):
            self.submitted.append((ref, text, kwargs))
            return {"ok": True, "queued": True, "admissionKey": "comment:" + kwargs["message_id"]}
        guard = patch.object(ai_exec, "say_sync", side_effect=say)
        guard.start(); self.addCleanup(guard.stop)
        # Continuation now restores the model pinned at dispatch. Keep this
        # isolated fixture complete; never bypass the continuation/owner checks.
        guard = patch("app.services.model_catalog.resolve", AsyncMock(return_value={
            "base": "https://fixture.invalid", "key": "isolated-im-fixture", "model": "im-fixture-model"}))
        guard.start(); self.addCleanup(guard.stop)

    async def request(self, method, path, **kwargs):
        return await self.http.request(method, "/api/v1/im" + path, **kwargs)

    async def connection(self, provider="telegram"):
        credentials = {"telegram": {"bot_token": "123456789:" + "fixture_bot_token_" * 2},
            "feishu": {"app_id": "cli_fixture_app", "app_secret": "fixture-app-secret", "verification_token": "fixture-verification",
             "encrypt_key": "fixture-encrypt-key"},
            "wecom": {"corp_id": "wwfixturecorp", "agent_id": "1000001", "app_secret": "fixture-app-secret",
                "verification_token": "fixtureToken", "encoding_aes_key": base64.b64encode(b"w" * 32).decode().rstrip("=")},
            "dingtalk": {"corp_id": "dingfixturecorp", "client_id": "dingfixtureclient", "robot_code": "dingfixturerobot",
                "app_secret": "fixture-ding-secret"}}[provider]
        created = await self.request("POST", "/connections", json={"provider": provider, "name": "Fixture", "credentials": credentials})
        self.assertEqual(created.status_code, 200, created.text)
        identifier = created.json()["id"]
        self.assertFalse(created.json()["enabled"])
        connected = await self.request("POST", "/connections/" + identifier + "/connect")
        self.assertEqual(connected.status_code, 200, connected.text)
        async with self.sessions() as session:
            row = await session.get(im.IMConnection, identifier)
            self.assertNotIn(next(iter(credentials.values())), row.credentials)
            return identifier, connections.unpack(row)

    async def pair(self, identifier, credentials, *, provider="telegram", event_id=1):
        reply = await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id, "allowStart": False})
        self.assertEqual(reply.status_code, 200, reply.text)
        command = reply.json()["command"]
        incoming = await self.incoming(identifier, credentials, command, event_id, provider=provider)
        self.assertEqual(incoming.status_code, 200, incoming.text)
        async with self.sessions() as session:
            binding = (await session.scalars(select(im.IMBinding).where(im.IMBinding.connection_id == identifier))).one()
            rows = list((await session.scalars(select(im.IMInbox))).all())
            self.assertNotIn(reply.json()["code"], "".join(row.text for row in rows))
            return binding.id, command

    async def incoming(self, identifier, credentials, text, event_id, *, provider="telegram", sender="42", chat="42", tenant="tenant-fixture",
                       age=0, tamper=False, encrypt=False):
        if provider == "telegram":
            body = {"update_id": event_id, "message": {"date": int(time.time()) - age, "message_id": event_id,
                "from": {"id": int(sender), "is_bot": False}, "chat": {"id": int(chat), "type": "private"}, "text": text}}
            raw = json.dumps(body).encode()
            headers = {"X-Telegram-Bot-Api-Secret-Token": "wrong" if tamper else credentials["webhook_secret"]}
        else:
            body = {"schema": "2.0", "header": {"event_id": str(event_id), "event_type": "im.message.receive_v1",
                "app_id": credentials["app_id"], "token": credentials["verification_token"], "tenant_key": tenant},
                "event": {"sender": {"sender_type": "user", "sender_id": {"open_id": sender}},
                    "message": {"message_id": "om_" + str(event_id), "chat_id": chat, "chat_type": "p2p", "message_type": "text",
                        "create_time": str(int(time.time() * 1000)), "content": json.dumps({"text": text})}}}
            raw = json.dumps(body).encode()
            if encrypt:
                padder = padding.PKCS7(128).padder()
                padded = padder.update(raw) + padder.finalize()
                iv = b"v" * 16
                cipher = Cipher(algorithms.AES(hashlib.sha256(credentials["encrypt_key"].encode()).digest()), modes.CBC(iv)).encryptor()
                raw = json.dumps({"encrypt": base64.b64encode(iv + cipher.update(padded) + cipher.finalize()).decode()}).encode()
            timestamp, nonce = str(int(time.time()) - age), "fixture-nonce"
            signature = hashlib.sha256((timestamp + nonce + credentials["encrypt_key"]).encode() + raw).hexdigest()
            headers = {"X-Lark-Request-Timestamp": timestamp, "X-Lark-Request-Nonce": nonce,
                "X-Lark-Signature": "wrong" if tamper else signature}
        return await self.request("POST", "/webhooks/" + identifier, content=raw, headers=headers)

    async def ready(self):
        async with self.sessions() as session:
            await session.execute(update(im.IMInbox).values(available_at=connections.now() - timedelta(seconds=1)))
            await session.execute(update(im.IMOutbox).where(im.IMOutbox.status == "queued").values(available_at=connections.now() - timedelta(seconds=1)))
            await session.commit()

    async def complete(self, text="已完成，结果正确", round_no=2, admission_key=None):
        async with self.sessions() as session:
            active = (await session.scalars(select(im.IMInbox).where(im.IMInbox.status == "waiting")
                .order_by(im.IMInbox.created_at))).first()
            key = admission_key if admission_key is not None else (active.admission_key if active else "")
            await execution_sessions.ingest_runner_snapshots(session, self.live, [{"taskId": self.task.id,
                "ref": "runner:im-ref", "state": "done", "round": round_no, "seq": round_no * 3 + 1,
                "admissionKey": key, "turnCorrelationVersion": 1,
                "items": [{"seq": round_no * 3, "kind": "say", "text": text, "round": round_no, "admissionKey": key},
                    {"seq": round_no * 3 + 1, "kind": "turn-end", "text": "", "round": round_no,
                     "admissionKey": key, "turnState": "done", "admissionStartSeq": round_no * 3 - 1}]}])
            await session.commit()

    async def enterprise_incoming(self, identifier, credentials, text, event_id, provider, *, tamper=False, tenant=None, timestamp=None, challenge=False):
        if provider == "wecom":
            raw = ("challenge-ok" if challenge else "<xml><ToUserName>" + credentials["corp_id"] + "</ToUserName>"
                "<AgentID>1000001</AgentID><FromUserName>fixture-user</FromUserName><MsgType>text</MsgType>"
                "<MsgId>" + str(event_id) + "</MsgId><CreateTime>" + str(int(time.time())) + "</CreateTime><Content>"
                + escape(text) + "</Content></xml>").encode()
            key = b"w" * 32
            plain = b"r" * 16 + struct.pack("!I", len(raw)) + raw + (tenant or credentials["corp_id"]).encode()
            pad = padding.PKCS7(256).padder()
            encryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).encryptor()
            encrypted = base64.b64encode(encryptor.update(pad.update(plain) + pad.finalize()) + encryptor.finalize()).decode()
            stamp, nonce = str(timestamp or int(time.time())), "fixture-nonce"
            signature = hashlib.sha1("".join(sorted([credentials["verification_token"], stamp, nonce, encrypted])).encode()).hexdigest()
            query = {"timestamp": stamp, "nonce": nonce, "msg_signature": "bad" if tamper else signature}
            if challenge:
                query["echostr"] = encrypted
                return await self.request("GET", "/webhooks/" + identifier, params=query)
            return await self.request("POST", "/webhooks/" + identifier, params=query,
                content=("<xml><Encrypt>" + encrypted + "</Encrypt></xml>").encode())
        stamp = str(timestamp or (int(time.time() * 1000) + event_id))
        signature = base64.b64encode(hmac.new(credentials["app_secret"].encode(),
            (stamp + "\n" + credentials["app_secret"]).encode(), hashlib.sha256).digest()).decode()
        return await self.request("POST", "/webhooks/" + identifier, json={"msgId": str(event_id), "robotCode": credentials["robot_code"],
            "chatbotCorpId": credentials["corp_id"], "senderCorpId": tenant or credentials["corp_id"], "conversationType": "1",
            "senderId": "fixture-ding-sender", "senderStaffId": "fixture-staff", "conversationId": "fixture-chat",
            "createAt": int(time.time() * 1000), "msgtype": "text", "text": {"content": text}},
            headers={"timestamp": stamp, "sign": "bad" if tamper else signature})
