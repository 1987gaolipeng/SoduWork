"""Long user instructions reach the real parser without database or model calls."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-long-text-parser-test-secret-20261014")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import tasks, work_catalog, llm


class LongTaskParseTests(unittest.IsolatedAsyncioTestCase):
    async def check_parser(self, client, primary_result):
        text = "请按以下要求创建自动化：\n" + "输入内容与约束。" * 800 + "\n最终要求：每天九点生成 CSV。"
        primary = AsyncMock(return_value=primary_result)
        fallback = AsyncMock(return_value='{"title":"报表自动化","note":"每天九点生成 CSV"}')
        catalog = AsyncMock(return_value={"scenarios": [], "recommendation": {}})
        with patch.object(work_catalog, "catalog_for_user", catalog), \
             patch.object(tasks, "_flow_choices", AsyncMock(return_value=[])), \
             patch.object(tasks, "_repo_choices", AsyncMock(return_value=[])), \
             patch.object(tasks, "_parse_with_my_model", primary), \
             patch.object(llm, "chat", fallback):
            result = await tasks.parse_task_text(object(), text, client=client, model="fixture")
        self.assertEqual(result["title"], "报表自动化")
        if client is not None:
            self.assertEqual(primary.await_args.args[4], text, "selected model must see the instruction tail")
        if client is None or not primary_result:
            self.assertEqual(fallback.await_args.args[2], text, "fallback must see the same complete instruction")
        else:
            fallback.assert_not_awaited()

    async def test_selected_model_receives_complete_long_instruction(self):
        await self.check_parser(SimpleNamespace(user_ref=None), '{"title":"报表自动化","note":"每天九点生成 CSV"}')

    async def test_empty_primary_response_keeps_complete_instruction_in_fallback(self):
        await self.check_parser(SimpleNamespace(user_ref=None), "")

    async def test_legacy_parser_keeps_complete_long_instruction(self):
        await self.check_parser(None, "")

    async def test_empty_instruction_does_not_call_a_model(self):
        with patch.object(tasks, "_parse_with_my_model", AsyncMock()) as primary, \
             patch.object(llm, "chat", AsyncMock()) as fallback:
            self.assertEqual(await tasks.parse_task_text(object(), "  \n"), {})
        primary.assert_not_awaited()
        fallback.assert_not_awaited()
