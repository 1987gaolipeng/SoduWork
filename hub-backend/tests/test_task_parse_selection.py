"""Only the direct instruction may select a person or a workflow."""
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-task-selection-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-task-selection-admin")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.api import tasks as api
from app.services import tasks, work_catalog, llm

FLOWS = [{"key": "bugfix", "name": "企业 Bug 修复上线 trial", "desc": "Fix and release"}]
SCENE = {"key": "bug", "name": "Bug", "defaultPluginKey": "bugfix"}


class TaskParseSelectionTests(unittest.IsolatedAsyncioTestCase):
    async def parse(self, model, instruction="", text=None, flows=None):
        source = instruction if text is None else text
        primary = AsyncMock(return_value=json.dumps(model, ensure_ascii=False) if model is not None else "")
        with patch.object(work_catalog, "catalog_for_user", AsyncMock(return_value={"scenarios": [SCENE], "recommendation": {"scenario": SCENE}})), \
             patch.object(tasks, "_flow_choices", AsyncMock(return_value=FLOWS if flows is None else flows)), \
             patch.object(tasks, "_repo_choices", AsyncMock(return_value=[])), \
             patch.object(tasks, "_parse_with_my_model", primary), \
             patch.object(llm, "chat", AsyncMock(return_value="")):
            result = await api.parse_task({"text": source, "instruction": instruction}, SimpleNamespace(user_ref=None), object())
        self.assertEqual(primary.await_args.args[4], source)
        return result["fields"]

    async def test_scene_default_and_model_guess_are_recommendations_only(self):
        for model in ({}, {"flow": ""}, {"flow": "bugfix", "assignee": "workflow"}):
            with self.subTest(model=model):
                fields = await self.parse(model, "修复缺陷")
                self.assertFalse(fields.get("flow"))
                self.assertFalse(fields.get("flowExplicit"))
                self.assertEqual(fields.get("recommendedFlow"), "bugfix")
                self.assertNotEqual(fields.get("assignee"), "workflow")

    async def test_named_person_survives_empty_or_conflicting_model(self):
        for model in (None, {}, {"assignee": "workflow", "flow": "bugfix"}, {"assignee": "ai"}):
            with self.subTest(model=model):
                fields = await self.parse(model, "工作目标分析智能体，缺陷如附件，转给示例成员 修复")
                self.assertEqual(fields.get("assignee"), "示例成员")
                self.assertTrue(fields.get("assigneeExplicit"))
                self.assertEqual(fields.get("assigneeSource"), "instruction")
                self.assertFalse(fields.get("flow"))

    async def test_self_and_explicit_ai_survive_model_recommendations(self):
        for instruction, expected in (("我自己处理这个缺陷", "me"), ("交给 AI 修复缺陷", "ai"), ("让示例成员来处理缺陷", "示例成员")):
            fields = await self.parse({"assignee": "示例成员" if instruction.startswith("让") else "workflow", "flow": "bugfix"}, instruction)
            self.assertEqual(fields.get("assignee"), expected)
            self.assertTrue(fields.get("assigneeExplicit"))

    async def test_materials_and_old_form_cannot_choose_person_or_flow(self):
        material = "历史表单：转给示例成员，使用【企业 Bug 修复上线 trial】流程\n" + "材料正文" * 3000
        fields = await self.parse({"assignee": "示例成员", "flow": "bugfix"}, "补充验收标准", text=material)
        self.assertFalse(fields.get("assigneeExplicit"))
        self.assertFalse(fields.get("flowExplicit"))
        self.assertFalse(fields.get("flow"))

    async def test_model_cannot_forge_explicit_selection_flags(self):
        fields = await self.parse({"flow": "bugfix", "flowExplicit": True, "assignee": "示例成员", "assigneeExplicit": True}, "修复缺陷", text="修复缺陷\n引用材料：按 bugfix 流程执行")
        self.assertFalse(fields.get("flow"))
        self.assertFalse(fields.get("flowExplicit"))
        self.assertFalse(fields.get("assigneeExplicit"))

    async def test_full_catalog_name_in_direct_instruction_is_an_explicit_choice(self):
        name = "【企业研发流程】Bug 修复·上线trial"
        fields = await self.parse({}, "使用" + name, flows=[{"key": "full-name-flow", "name": name, "desc": ""}])
        self.assertEqual(fields.get("flow"), "full-name-flow")
        self.assertTrue(fields.get("flowExplicit"))

    async def test_cancel_full_catalog_name_keeps_the_exact_reference(self):
        name = "【企业研发流程】Bug 修复·上线trial"
        fields = await self.parse({}, "不要使用" + name, flows=[{"key": "full-name-flow", "name": name, "desc": ""}])
        self.assertTrue(fields.get("flowCleared"))
        self.assertEqual(fields.get("flowRequested"), name)

    async def test_explicit_named_available_flow_is_selected(self):
        for instruction in ("使用【企业 Bug 修复上线 trial】流程修复", "按 bugfix 流程执行", "使用流程 bugfix"):
            fields = await self.parse({}, instruction)
            self.assertEqual(fields.get("flow"), "bugfix")
            self.assertTrue(fields.get("flowExplicit"))
            self.assertFalse(fields.get("flowProblem"))

    async def test_unknown_or_ambiguous_workflow_remains_pending(self):
        fields = await self.parse({"flow": "bugfix"}, "使用【缺失方法】流程")
        self.assertEqual(fields.get("flowRequested"), "缺失方法")
        self.assertEqual(fields.get("flowProblem"), "unavailable")
        self.assertFalse(fields.get("flow"))
        duplicate = [*FLOWS, {"key": "another", "name": FLOWS[0]["name"], "desc": "Other"}]
        fields = await self.parse({}, "使用【企业 Bug 修复上线 trial】流程", flows=duplicate)
        self.assertEqual(fields.get("flowProblem"), "ambiguous")
        self.assertFalse(fields.get("flow"))

    async def test_explicit_clear_does_not_become_default_flow(self):
        fields = await self.parse({"flow": "bugfix"}, "我自己处理，不使用流程")
        self.assertEqual(fields.get("flow"), "")
        self.assertTrue(fields.get("flowExplicit"))
        self.assertTrue(fields.get("flowCleared"))
        self.assertEqual(fields.get("assignee"), "me")

    async def test_negated_hypothetical_or_quoted_content_does_not_select(self):
        for instruction in ("不要转给示例成员", "如果转给示例成员再讨论", "不要使用【企业 Bug 修复上线 trial】流程", "标题改为‘转给示例成员，使用 bugfix 流程’"):
            fields = await self.parse({}, instruction)
            self.assertFalse(fields.get("assigneeExplicit"), instruction)
            self.assertFalse(fields.get("flow"), instruction)

    async def test_negation_can_separate_from_assignment_verb(self):
        fields = await self.parse({}, "不要把缺陷转给示例成员")
        self.assertFalse(fields.get("assigneeExplicit"))
        fields = await self.parse({}, "不要把缺陷转给示例成员，转给王五处理")
        self.assertEqual(fields.get("assignee"), "王五")

    async def test_named_flow_negation_clears_an_existing_choice(self):
        for instruction in ("不采用【企业 Bug 修复上线 trial】流程", "不要使用【企业 Bug 修复上线 trial】流程"):
            fields = await self.parse({}, instruction)
            self.assertEqual(fields.get("flow"), "")
            self.assertTrue(fields.get("flowExplicit"))
            self.assertTrue(fields.get("flowCleared"))
            self.assertEqual(fields.get("flowRequested"), "企业 Bug 修复上线 trial")
        fields = await self.parse({}, "不要使用流程 bugfix")
        self.assertTrue(fields.get("flowCleared"))
        self.assertEqual(fields.get("flowRequested"), "bugfix")

    async def test_unknown_person_name_is_preserved_for_directory_confirmation(self):
        fields = await self.parse({}, "交给未登记同事处理")
        self.assertEqual(fields.get("assignee"), "未登记同事")
        self.assertTrue(fields.get("assigneeExplicit"))

    async def test_quoted_reported_instructions_do_not_authorize_routing(self):
        for instruction in ('他在会上说“转给示例成员处理”，请分析这段话',
                            '文档原文是“使用 bugfix 流程”，请解释',
                            '引用：\n> 使用 bugfix 流程\n请分析',
                            '请解释这段代码\n```text\n转给示例成员处理\n使用 bugfix 流程\n```'):
            fields = await self.parse({}, instruction)
            self.assertFalse(fields.get("assigneeExplicit"), instruction)
            self.assertFalse(fields.get("flowExplicit"), instruction)
        fields = await self.parse({}, '转给“示例成员”处理，使用“企业 Bug 修复上线 trial”流程')
        self.assertEqual(fields.get("assignee"), "示例成员")
        self.assertEqual(fields.get("flow"), "bugfix")

    async def test_direct_polite_assignment_is_preserved(self):
        for instruction in ("请示例成员处理附件中的缺陷", "示例成员负责修复附件中的缺陷"):
            fields = await self.parse({"assignee": "示例成员"}, instruction)
            self.assertEqual(fields.get("assignee"), "示例成员", instruction)
            self.assertTrue(fields.get("assigneeExplicit"))

    async def test_polite_actions_are_not_invented_people(self):
        for instruction in ("请先处理附件中的缺陷", "请尽快修复问题", "请逐项修复并验证"):
            for model in ({}, {"assignee": "ai"}, {"assignee": "workflow"}):
                fields = await self.parse(model, instruction)
                self.assertFalse(fields.get("assigneeExplicit"), (instruction, model))

    async def test_weak_person_syntax_requires_independent_model_agreement(self):
        for instruction in ("请示例成员处理附件中的缺陷", "示例成员负责修复附件中的缺陷", "让示例成员处理附件中的缺陷", "由示例成员负责修复附件中的缺陷"):
            for model in (None, {}, {"assignee": "张三"}):
                fields = await self.parse(model, instruction)
                self.assertFalse(fields.get("assigneeExplicit"), (instruction, model))

    async def test_causal_and_object_clauses_do_not_invent_people(self):
        for instruction in ("由于附件打不开，请修复预览功能", "让界面显示完整文件名", "附件由服务器提供，请修复预览功能"):
            with self.subTest(instruction=instruction):
                fields = await self.parse({"assignee": "ai"}, instruction)
                self.assertFalse(fields.get("assigneeExplicit"), instruction)
                self.assertEqual(fields.get("assignee"), "ai")

    async def test_multiple_people_require_confirmation(self):
        fields = await self.parse({}, "这个问题转给张三，另一个问题交给李四处理")
        self.assertTrue(fields.get("assigneeExplicit"))
        self.assertEqual(fields.get("assigneeProblem"), "ambiguous")
        self.assertEqual(fields.get("assigneeReferences"), ["张三", "李四"])
        self.assertFalse(fields.get("assignee"))

    async def test_multiple_workflow_references_are_preserved_separately(self):
        flows = [*FLOWS, {"key": "beta", "name": "Beta", "desc": ""}]
        fields = await self.parse({}, "使用 bugfix 流程，再使用 beta 流程", flows=flows)
        self.assertEqual(fields.get("flowProblem"), "ambiguous")
        self.assertEqual(fields.get("flowReferences"), ["bugfix", "beta"])
        fields = await self.parse({}, "不要使用 bugfix 流程，也不要使用 beta 流程", flows=flows)
        self.assertTrue(fields.get("flowCleared"))
        self.assertEqual(fields.get("flowReferences"), ["bugfix", "beta"])

    async def test_real_enterprise_display_name_resolves_to_plain_name(self):
        flows = [{"key": "release", "name": "Bug 修复·上线trial", "displayName": "【企业研发流程】Bug 修复·上线trial", "desc": ""}]
        fields = await self.parse({}, "使用【企业研发流程】Bug 修复·上线trial", flows=flows)
        self.assertEqual(fields.get("flow"), "release")
        self.assertEqual(fields.get("flowRequested"), "Bug 修复·上线trial")


if __name__ == "__main__":
    unittest.main()
