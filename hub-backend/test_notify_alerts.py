"""External alert receipts must reflect delivery failures without interrupting tasks."""
import io
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-notify-alerts-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-notify-alerts-admin")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import notify


class NotifyAlertTests(unittest.IsolatedAsyncioTestCase):
    async def send(self, url, payload=b"", *, status=200, error=None):
        rows = Mock()
        rows.scalars.return_value.first.return_value = SimpleNamespace(value=url)
        session = SimpleNamespace(execute=AsyncMock(return_value=rows))
        raw = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
        response = Mock(status=status)
        response.read.side_effect = io.BytesIO(raw).read
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=None)
        opener = Mock()
        opener.open = Mock(side_effect=error) if error else Mock(return_value=response)
        with patch.object(notify.urllib.request, "build_opener", return_value=opener):
            accepted = await notify.alert(session, "Fixture alert", task=SimpleNamespace(title="Fixture task"))
        return accepted, opener, response

    async def test_platform_success_requires_zero_business_code(self):
        cases = [
            ("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture", {"errcode": 0, "errmsg": "ok"}),
            ("https://oapi.dingtalk.com/robot/send?access_token=fixture", {"errcode": 0, "errmsg": "ok"}),
            ("https://open.feishu.cn/open-apis/bot/v2/hook/fixture", {"code": 0, "msg": "success"}),
            ("https://open.feishu.cn/open-apis/bot/v2/hook/fixture", {"StatusCode": 0, "StatusMessage": "success"}),
            ("https://open.larksuite.com/open-apis/bot/v2/hook/fixture", {"code": 0, "StatusCode": 0}),
        ]
        for url, reply in cases:
            with self.subTest(url=url, reply=reply):
                accepted, opener, response = await self.send(url, reply)
                self.assertTrue(accepted)
                opener.open.assert_called_once()
                self.assertEqual(opener.open.call_args.kwargs["timeout"], notify._ALERT_TIMEOUT)
                response.read.assert_called_once_with(notify._ALERT_RESPONSE_LIMIT + 1)
                body = json.loads(opener.open.call_args.args[0].data)
                self.assertEqual(body["text"]["content"], body["content"]["text"])
                self.assertIn("Fixture task", body["text"]["content"])

    async def test_platform_http_success_with_business_error_is_not_delivery(self):
        cases = [
            ("https://qyapi.weixin.qq.com/cgi-bin/webhook/send", {"errcode": 93000, "errmsg": "fixture-secret"}),
            ("https://oapi.dingtalk.com/robot/send", {"errcode": 310000, "errmsg": "fixture-secret"}),
            ("https://open.feishu.cn/open-apis/bot/v2/hook/fixture", {"code": 19021, "msg": "fixture-secret"}),
            ("https://open.feishu.cn/open-apis/bot/v2/hook/fixture", {"code": 9499, "StatusCode": 0}),
            ("https://open.larksuite.com/open-apis/bot/v2/hook/fixture", {"StatusCode": 9499}),
        ]
        for url, reply in cases:
            with self.subTest(url=url, reply=reply), self.assertLogs("uvicorn.error", level="WARNING") as logs:
                accepted, opener, _ = await self.send(url, reply)
                self.assertFalse(accepted)
                opener.open.assert_called_once()
            self.assertNotIn("fixture-secret", "".join(logs.output))
            self.assertNotIn(url, "".join(logs.output))

    async def test_platform_missing_malformed_and_non_integer_codes_fail_closed(self):
        for reply in [b"", b"<html>OK</html>", b"\xff", [], {}, {"code": False},
                      {"code": None}, {"code": "0"}, {"code": 0.0}, {"errcode": 0}]:
            with self.subTest(reply=reply):
                accepted, opener, _ = await self.send("https://open.feishu.cn/open-apis/bot/v2/hook/fixture", reply)
                self.assertFalse(accepted)
                opener.open.assert_called_once()

    async def test_generic_receivers_keep_http_success_contract(self):
        for status, body in [(200, b"ok"), (202, {"code": 202}), (204, b"")]:
            with self.subTest(status=status):
                accepted, _, _ = await self.send("https://alerts.example.test/hook", body, status=status)
                self.assertTrue(accepted)
        accepted, _, _ = await self.send("https://alerts.example.test/hook", b"ok", status=500)
        self.assertFalse(accepted)

    async def test_oversized_receipts_and_network_errors_fail_without_retry(self):
        accepted, opener, response = await self.send("https://alerts.example.test/hook",
                                                   b"x" * (notify._ALERT_RESPONSE_LIMIT + 10))
        self.assertFalse(accepted)
        opener.open.assert_called_once()
        response.read.assert_called_once_with(notify._ALERT_RESPONSE_LIMIT + 1)
        with self.assertLogs("uvicorn.error", level="WARNING") as logs:
            accepted, opener, _ = await self.send("https://alerts.example.test/hook",
                                                 error=TimeoutError("fixture-secret"))
        self.assertFalse(accepted)
        opener.open.assert_called_once()
        self.assertNotIn("fixture-secret", "".join(logs.output))

    async def test_disabled_alerts_make_no_request(self):
        for url in ["", "file:///fixture", "not-a-url"]:
            with self.subTest(url=url):
                accepted, opener, _ = await self.send(url)
                self.assertFalse(accepted)
                opener.open.assert_not_called()

    async def test_rejected_webhook_does_not_undo_stakeholder_notifications(self):
        session, task = object(), SimpleNamespace(id="fixture-task")
        with patch.object(notify, "notify_task", new=AsyncMock(return_value=2)) as devices, \
             patch.object(notify, "alert", new=AsyncMock(return_value=False)) as webhook:
            result = await notify.notify_and_alert(session, task, "Fixture", extra={"kind": "release"})
        self.assertEqual(result, {"devices": 2, "webhook": False})
        devices.assert_awaited_once_with(session, task, "Fixture", extra={"kind": "release"})
        webhook.assert_awaited_once_with(session, "Fixture", task=task)


if __name__ == "__main__":
    unittest.main()
