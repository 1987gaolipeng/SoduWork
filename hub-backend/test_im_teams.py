"""Teams accepts only endorsed Microsoft channel tokens and replies to their bound URL."""
import json
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from urllib.parse import parse_qs

import im_test_support as fixture
import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from app import im_models as im
from app.services import im_connections as connections, im_teams, im_transport, im_worker


class TeamsIMTests(unittest.IsolatedAsyncioTestCase):
    request = fixture.IMFixture.request
    ready = fixture.IMFixture.ready
    complete = fixture.IMFixture.complete

    async def asyncSetUp(self):
        await fixture.IMFixture.asyncSetUp(self)
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.foreign_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.jwk = {**jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key(), as_dict=True),
            "kid": "fixture-teams-key", "use": "sig", "alg": "RS256", "endorsements": ["msteams"]}
        self.credentials = {"app_id": "11111111-2222-3333-4444-555555555555",
            "tenant_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "client_secret": "fixture-teams-secret"}
        self.url = "https://smba.trafficmanager.net/amer/"
        self.metadata_calls, self.token_calls, self.reply_urls = 0, 0, []
        self.metadata_failure = False
        original_http = type(self.http)
        def platform(request):
            if str(request.url) == im_teams.METADATA:
                self.metadata_calls += 1
                value = {"issuer": im_teams.ISSUER, "jwks_uri": im_teams.KEYS,
                    "id_token_signing_alg_values_supported": ["RS256"]}
                if self.metadata_failure:
                    value["jwks_uri"] = "https://attacker.example/keys"
            elif str(request.url) == im_teams.KEYS:
                value = {"keys": [self.jwk]}
            elif request.url.host == "login.microsoftonline.com":
                self.token_calls += 1
                self.assertIn("application/x-www-form-urlencoded", request.headers["content-type"])
                payload = parse_qs(request.content.decode())
                self.assertEqual(payload["scope"], ["https://api.botframework.com/.default"])
                self.assertEqual(payload["client_id"], [self.credentials["app_id"]])
                value = {"token_type": "Bearer", "expires_in": 3600, "access_token": "fixture-teams-access"}
            elif request.url.host == "smba.trafficmanager.net":
                self.reply_urls.append(str(request.url))
                self.assertEqual(request.headers["authorization"], "Bearer fixture-teams-access")
                self.sent.append(json.loads(request.content))
                value = {"id": "reply-" + str(len(self.sent))}
            else:
                self.fail("Unexpected external URL")
            return httpx.Response(200, json=value)
        guard = patch.object(im_transport.httpx, "AsyncClient", side_effect=lambda **kwargs:
            original_http(transport=httpx.MockTransport(platform), **kwargs))
        guard.start(); self.addCleanup(guard.stop)

    async def connection(self):
        result = await self.request("POST", "/connections", json={"provider": "teams", "credentials": self.credentials})
        self.assertEqual(result.status_code, 200, result.text)
        identifier = result.json()["id"]
        result = await self.request("POST", "/connections/" + identifier + "/connect")
        self.assertEqual(result.status_code, 200, result.text)
        return identifier

    async def incoming(self, identifier, text, event_id, *, claims=None, body_changes=None, key=None, headers=None):
        body = {"type": "message", "id": str(event_id), "timestamp": datetime.now(timezone.utc).isoformat(),
            "channelId": "msteams", "serviceUrl": self.url, "channelData": {"tenant": {"id": self.credentials["tenant_id"]}},
            "recipient": {"id": "28:" + self.credentials["app_id"]}, "from": {"id": "29:fixture-teams-user"},
            "conversation": {"id": "a:" + "fixture" * 40, "conversationType": "personal", "tenantId": self.credentials["tenant_id"]},
            "text": text, **(body_changes or {})}
        value = {"iss": im_teams.ISSUER, "aud": self.credentials["app_id"], "nbf": int(time.time()) - 60,
            "exp": int(time.time()) + 3600, "serviceurl": self.url, **(claims or {})}
        token = jwt.encode(value, key or self.key, algorithm="RS256", headers={"kid": "fixture-teams-key", **(headers or {})})
        return await self.request("POST", "/webhooks/" + identifier, json=body, headers={"Authorization": "Bearer " + token})

    async def test_signed_activity_to_desktop_and_exact_final_reply(self):
        identifier = await self.connection()
        code = (await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})).json()["command"]
        self.assertTrue(code.startswith("pair "))
        result = await self.incoming(identifier, code, 1)
        self.assertEqual(result.status_code, 200, result.text)
        for _ in range(2):
            result = await self.incoming(identifier, "explain <script> & code", 2)
            self.assertEqual(result.status_code, 200, result.text)
        await im_worker.run_once(self.sessions)
        self.assertEqual([item[1] for item in self.submitted], ["explain <script> & code"])
        await self.complete("Teams 完整结果")
        for _ in range(4):
            await self.ready(); await im_worker.run_once(self.sessions)
        self.assertTrue(any("Teams 完整结果" in item["text"] for item in self.sent))
        self.assertTrue(all(item["textFormat"] == "plain" and item["recipient"]["id"] == "29:fixture-teams-user" for item in self.sent))
        self.assertTrue(all(url.startswith(self.url + "v3/conversations/a%3A") for url in self.reply_urls))
        self.assertEqual(self.token_calls, 1)
        self.assertEqual(self.metadata_calls, 1)
        conflict = await self.incoming(identifier, "changed replay", 2)
        self.assertEqual(conflict.status_code, 409)

    async def test_invalid_signature_claims_channel_tenant_and_reply_url_cannot_pair(self):
        identifier = await self.connection()
        command = (await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})).json()["command"]
        cases = [
            {"key": self.foreign_key}, {"claims": {"aud": "other-app"}}, {"claims": {"iss": "https://attacker.example"}},
            {"claims": {"exp": int(time.time()) - 600}}, {"claims": {"nbf": int(time.time()) + 600}},
            {"claims": {"serviceurl": "https://attacker.example/"}}, {"headers": {"kid": "unknown"}},
            {"body_changes": {"channelId": "webchat"}}, {"body_changes": {"channelData": {"tenant": {"id": "other"}}}},
            {"body_changes": {"serviceUrl": "https://127.0.0.1/"}, "claims": {"serviceurl": "https://127.0.0.1/"}},
            {"body_changes": {"serviceUrl": "https://smba.trafficmanager.net@attacker.example/teams/"},
             "claims": {"serviceurl": "https://smba.trafficmanager.net@attacker.example/teams/"}},
            {"body_changes": {"recipient": {"id": "28:other-bot"}}},
        ]
        for options in cases:
            with self.subTest(options=list(options)):
                result = await self.incoming(identifier, command, 1, **options)
                self.assertEqual(result.status_code, 401, result.text)
        async with self.sessions() as session:
            self.assertEqual(list((await session.scalars(select(im.IMBinding))).all()), [])
        self.assertEqual(self.metadata_calls, 1)
        self.assertEqual(self.sent, [])

    async def test_key_endorsement_and_metadata_url_are_not_optional(self):
        identifier = await self.connection()
        self.jwk["endorsements"] = ["webchat"]
        im_teams._key_caches.clear()
        result = await self.incoming(identifier, "work", 1)
        self.assertEqual(result.status_code, 403)
        self.metadata_failure = True
        im_teams._key_caches.clear()
        result = await self.incoming(identifier, "work", 2)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(self.sent, [])

    async def test_channel_pairing_binds_only_its_original_thread(self):
        identifier = await self.connection()
        command = (await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})).json()["command"]
        channel = {"conversation": {"id": "19:fixture@thread.tacv2", "conversationType": "channel"},
            "entities": [{"type": "mention", "text": "<at>Fixture</at>", "mentioned": {"id": "28:" + self.credentials["app_id"]}}]}
        result = await self.incoming(identifier, "<at>Fixture</at> " + command, 100, body_changes=channel)
        self.assertEqual(result.status_code, 200, result.text)
        result = await self.incoming(identifier, "<at>Fixture</at> other thread", 200, body_changes=channel)
        self.assertEqual(result.status_code, 200)
        result = await self.incoming(identifier, "<at>Fixture</at> same thread", 101,
            body_changes={**channel, "replyToId": "100"})
        self.assertEqual(result.status_code, 200)
        await im_worker.run_once(self.sessions)
        self.assertEqual([item[1] for item in self.submitted], ["same thread"])

        encoded_channel = {**channel, "conversation": {"id": "19:fixture@thread.tacv2;messageid=300", "conversationType": "channel"}}
        code = (await self.request("POST", "/connections/" + identifier + "/pairings",
            json={"taskId": self.task.id, "runnerId": self.node.id})).json()["command"]
        self.assertEqual((await self.incoming(identifier, "<at>Fixture</at> " + code, 301, body_changes={
            **encoded_channel, "replyToId": "300"})).status_code, 200)
        self.assertEqual((await self.incoming(identifier, "<at>Fixture</at> quoted in same thread", 302, body_changes={
            **encoded_channel, "replyToId": "301"})).status_code, 200)
        async with self.sessions() as session:
            row = (await session.scalars(select(im.IMInbox).where(im.IMInbox.text == "quoted in same thread"))).one()
            binding = await session.get(im.IMBinding, row.binding_id)
            self.assertEqual(binding.external_identity["thread"], "300")


if __name__ == "__main__":
    unittest.main()
