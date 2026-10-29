"""Distributed governance tests for plugin MCP tickets."""

import unittest
from unittest.mock import patch

from app.services import plugin_mcp_limits as limits


class FakeRedis:
    def __init__(self, responses=None):
        self.responses = list(responses or [[1, 0, 0]])
        self.calls = []

    async def eval(self, *args):
        self.calls.append(args)
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class FakeBus:
    enabled = True

    def __init__(self, redis):
        self.redis = redis

    @staticmethod
    def key(kind, identity=""):
        return f"test:{kind}:{identity}"


class DistributedPluginMcpLimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_acquire_and_release_use_shared_redis_leases(self):
        redis = FakeRedis([[1, 0, 0], 1])
        bus = FakeBus(redis)
        claims = {"jti": "turn-1", "cid": "client-1", "mcc": 2}
        with patch.object(limits, "_cluster_runtime", return_value=bus):
            lease = await limits.acquire(claims, "soduwork-media", "call")
            self.assertTrue(lease.distributed)
            self.assertIn("plugin-mcp-turn", lease.turn_key)
            await limits.release(lease, True)
        self.assertEqual(len(redis.calls), 2)
        self.assertEqual(redis.calls[0][0], limits._REDIS_ACQUIRE)
        self.assertEqual(redis.calls[1][0], limits._REDIS_RELEASE)
        self.assertEqual(redis.calls[1][4], "1")

    async def test_cluster_limits_fail_closed_and_preserve_retry_reason(self):
        cases = [
            ([0, 1, 0], "call-budget"),
            ([0, 2, 0], "list-budget"),
            ([0, 3, 1], "concurrency"),
            ([0, 4, 9], "circuit-open"),
        ]
        for response, expected in cases:
            with self.subTest(expected):
                bus = FakeBus(FakeRedis([response]))
                with patch.object(limits, "_cluster_runtime", return_value=bus):
                    with self.assertRaises(limits.PluginMcpLimitError) as caught:
                        await limits.acquire(
                            {"jti": "turn", "cid": "client"},
                            "soduwork-media", "list" if expected == "list-budget" else "call")
                self.assertEqual(caught.exception.kind, expected)

        with patch.object(
                limits, "_cluster_runtime", return_value=FakeBus(None)):
            with self.assertRaises(limits.PluginMcpLimitError) as caught:
                await limits.acquire(
                    {"jti": "turn", "cid": "client"}, "soduwork-media", "call")
        self.assertEqual(caught.exception.kind, "governance-unavailable")


if __name__ == "__main__":
    unittest.main()
