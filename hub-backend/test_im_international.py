"""Signed Slack and Discord callbacks use the same durable execution boundary."""
import hashlib
import hmac
import json
import time
import unittest
import uuid
from datetime import timedelta
from unittest.mock import patch

import im_test_support as fixture
import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from sqlalchemy import select, update

from app import im_models as im
from app.services import im_connections as connections, im_transport, im_worker


class InternationalIMTests(unittest.IsolatedAsyncioTestCase):
    request = fixture.IMFixture.request
    ready = fixture.IMFixture.ready
    complete = fixture.IMFixture.complete

    async def asyncSetUp(self):
        await fixture.IMFixture.asyncSetUp(self)
        self.private_key = Ed25519PrivateKey.generate()
        self.credentials = {
            "slack": {"app_id": "AFIXTURE01", "bot_token": "xoxb-fixture-token-that-is-not-real",
                "signing_secret": "fixtureSigningSecret00000001"},
            "discord": {"application_id": "123456789012345678", "bot_token": "fixture.bot.token.not.real",
                "public_key": self.private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()},
        }
        original_http = type(self.http)
        def platform(request):
            payload = json.loads(request.content) if request.content else {}
            if request.url.path == "/api/auth.test":
                value = {"ok": True, "bot_id": "BFIXTURE01", "user_id": "UBOTFIXTURE", "team_id": "TFIXTURE01"}
            elif request.url.path.endswith("/oauth2/applications/@me"):
                value = {"id": self.credentials["discord"]["application_id"], "verify_key": self.credentials["discord"]["public_key"]}
            elif request.url.path.endswith("/commands"):
                self.assertEqual(payload["integration_types"], [0])
                self.assertEqual(payload["contexts"], [0, 1])
                value = {"id": "11111111" if payload["name"] == "pair" else "22222222", "name": payload["name"]}
            else:
                self.sent.append(payload)
                value = {"ok": True, "ts": "1234567.000001"} if request.url.host == "slack.com" else {"id": str(77777777 + len(self.sent))}
            return httpx.Response(200, json=value)
        guard = patch.object(im_transport.httpx, "AsyncClient", side_effect=lambda **kwargs:
            original_http(transport=httpx.MockTransport(platform), **kwargs))
        guard.start(); self.addCleanup(guard.stop)

    async def connection(self, provider):
        result = await self.request("POST", "/connections", json={"provider": provider, "credentials": self.credentials[provider]})
        self.assertEqual(result.status_code, 200, result.text)
        identifier = result.json()["id"]
        result = await self.request("POST", "/connections/" + identifier + "/connect")
        self.assertEqual(result.status_code, 200, result.text)
        return identifier

    async def incoming(self, identifier, provider, text, event_id, *, tamper=False, age=0, wrong_tenant=False, ping=False):
        stamp = str(int(time.time()) - age)
        if provider == "slack":
            body = {"type": "event_callback", "api_app_id": "AFIXTURE01", "team_id": "TOTHER" if wrong_tenant else "TFIXTURE01",
                "event_id": "E" + str(event_id), "event_time": int(time.time()), "event": {"type": "message", "channel_type": "im",
                "user": "UFIXTURE01", "channel": "DFIXTURE01", "text": text}}
            if ping:
                body = {"type": "url_verification", "challenge": "fixture-challenge"}
            raw = json.dumps(body).encode()
            signature = "v0=" + hmac.new(self.credentials[provider]["signing_secret"].encode(),
                b"v0:" + stamp.encode() + b":" + raw, hashlib.sha256).hexdigest()
            headers = {"x-slack-request-timestamp": stamp, "x-slack-signature": "bad" if tamper else signature}
        else:
            pair = text.startswith("/pair code:")
            body = {"id": str(9000000 + event_id), "application_id": "999999999" if wrong_tenant else self.credentials[provider]["application_id"],
                "type": 1 if ping else 2, "context": 1, "authorizing_integration_owners": {"0": "0"},
                "user": {"id": "555555555"}, "channel_id": "444444444", "token": "must-never-be-stored",
                "data": {"id": "11111111" if pair else "22222222", "type": 1, "name": "pair" if pair else "soduwork",
                "options": [{"name": "code" if pair else "text", "type": 3, "value": text[11:] if pair else text}]}}
            raw = json.dumps(body).encode()
            signature = self.private_key.sign(stamp.encode() + raw).hex()
            headers = {"x-signature-timestamp": stamp, "x-signature-ed25519": "00" * 64 if tamper else signature}
        return await self.request("POST", "/webhooks/" + identifier, content=raw, headers=headers)

    async def full_path(self, provider):
        identifier = await self.connection(provider)
        ping = await self.incoming(identifier, provider, "", 0, ping=True)
        self.assertEqual(ping.status_code, 200, ping.text)
        self.assertEqual(ping.json(), {"type": 1} if provider == "discord" else {"challenge": "fixture-challenge"})
        result = await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})
        command = result.json()["command"]
        self.assertTrue(command.startswith("/pair code:" if provider == "discord" else "pair "))
        incoming = await self.incoming(identifier, provider, command, 1)
        self.assertEqual(incoming.status_code, 200, incoming.text)
        for options in ({"tamper": True}, {"age": 301}, {"wrong_tenant": True}):
            self.assertEqual((await self.incoming(identifier, provider, "forged", 2, **options)).status_code, 401)
        for _ in range(2):
            result = await self.incoming(identifier, provider, "work & verify", 2)
            self.assertEqual(result.status_code, 200, result.text)
        await im_worker.run_once(self.sessions)
        self.assertEqual([item[1] for item in self.submitted], ["work & verify"])
        await self.complete("国际平台结果 @everyone")
        for _ in range(4):
            await self.ready(); await im_worker.run_once(self.sessions)
        async with self.sessions() as session:
            rows = list((await session.scalars(select(im.IMInbox))).all())
            self.assertTrue(all("must-never-be-stored" not in json.dumps(row.reply_context) for row in rows))
        return identifier

    async def test_slack_signed_events_execute_once_and_reply_without_mentions(self):
        await self.full_path("slack")
        self.assertTrue(any("国际平台结果" in item["text"] for item in self.sent))
        self.assertTrue(all(item["mrkdwn"] is False and item["parse"] == "none" for item in self.sent))
        from app.services.im_slack import checked
        with self.assertRaises(im_transport.TransportError) as raised:
            checked({"ok": False, "error": "internal_error"})
        self.assertTrue(raised.exception.uncertain)

    async def test_discord_ed25519_commands_execute_once_and_use_persistent_bot_replies(self):
        identifier = await self.full_path("discord")
        self.assertTrue(any("国际平台结果" in item["content"] for item in self.sent))
        self.assertTrue(all(item["allowed_mentions"] == {"parse": []} and item["enforce_nonce"] for item in self.sent))
        from app.services.im_ingress import enqueue_reply
        async with self.sessions() as session:
            inbox = (await session.scalars(select(im.IMInbox).where(im.IMInbox.connection_id == identifier))).first()
            await enqueue_reply(session, inbox, "long-result", "😀" * 2000)
            await session.commit()
            parts = list((await session.scalars(select(im.IMOutbox).where(im.IMOutbox.kind == "long-result").order_by(im.IMOutbox.part))).all())
            self.assertEqual("".join(part.text for part in parts), "😀" * 2000)
            self.assertTrue(all(len(part.text.encode("utf-16-le")) // 2 <= 1900 for part in parts))

    async def test_paused_binding_with_fifty_queued_messages_does_not_starve_another_binding(self):
        first = await self.full_path("slack")
        second = await self.connection("discord")
        code = (await self.request("POST", "/connections/" + second + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})).json()["command"]
        self.assertEqual((await self.incoming(second, "discord", code, 1)).status_code, 200)
        async with self.sessions() as session:
            old = (await session.scalars(select(im.IMInbox).where(im.IMInbox.connection_id == first))).first()
            stamp = connections.now() - timedelta(minutes=10)
            for index in range(51):
                session.add(im.IMOutbox(id=str(uuid.uuid4()), inbox_id=old.id, connection_id=first,
                    binding_id=old.binding_id, kind="blocked", part=index, text="must stay blocked",
                    status="uncertain" if index == 0 else "queued", available_at=stamp,
                    created_at=stamp + timedelta(seconds=index)))
            await session.commit()
        self.sent.clear()
        await im_worker.run_once(self.sessions)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("content", self.sent[0])
        async with self.sessions() as session:
            blocked = list((await session.scalars(select(im.IMOutbox).where(im.IMOutbox.kind == "blocked"))).all())
            self.assertEqual(sum(row.status == "queued" for row in blocked), 50)


if __name__ == "__main__":
    unittest.main()
