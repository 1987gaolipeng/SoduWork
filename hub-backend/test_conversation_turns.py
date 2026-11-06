import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.services import conversation_turns, task_status, task_events, dispatch_attempts

class ConversationTurnsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.task=SimpleNamespace(id="t", status="todo", work_routing={})
        self.patches=[
            patch.object(conversation_turns,"_workflow_starting",AsyncMock(return_value=False)),
            patch.object(conversation_turns,"_has_active_execution",AsyncMock(return_value=False)),
            patch.object(task_status,"engine_owns",AsyncMock(return_value=set())),
            patch.object(task_status,"mark",AsyncMock(return_value=True)),
            patch.object(task_events,"record"),
            patch.object(dispatch_attempts,"existing",AsyncMock(return_value=None)),
            patch.object(conversation_turns,"_cancel_turn_review",AsyncMock())]
        for p in self.patches: p.start()
        self.body={"turnId":"turn","conversationId":"conversation"}
    async def asyncTearDown(self):
        for p in self.patches: p.stop()
    async def apply(self,action):
        return await conversation_turns.apply(None,self.task,{**self.body,"action":action})
    async def test_conversation_instruction_is_preserved_or_rejected_never_truncated(self):
        text = "x" * 4000 + "TAIL-EVIDENCE"
        self.assertEqual(conversation_turns.execution_instruction(text, self.body), text)
        self.assertEqual(conversation_turns.execution_instruction(text), text)
        with self.assertRaises(HTTPException):
            conversation_turns.execution_instruction("x" * 50001, self.body)
        with self.assertRaises(HTTPException):
            conversation_turns.execution_instruction("x" * 50001)
    async def test_duplicate_prepare_is_idempotent_and_other_conversation_rejected(self):
        await self.apply("prepare")
        await self.apply("prepare")
        self.assertEqual(task_events.record.call_count,1)
        with self.assertRaises(HTTPException):
            await conversation_turns.apply(None,self.task,{**self.body,"conversationId":"other"})

    async def test_runner_continuation_preserves_rework_until_admission_and_does_not_redispatch(self):
        from app.services import ai_exec
        self.task.status = "doing"
        pending = {"ref": "original", "feedback": "shorten", "state": "awaiting_executor"}
        self.task.work_routing = {"reworkPending": pending, "conversationTurn": {
            "turnId": "first", "conversationId": "conversation", "state": "completed", "executor": "dispatch"}}
        with patch.object(ai_exec, "last_dispatch_event", AsyncMock(return_value=SimpleNamespace(detail={"ref": "original"}))):
            for invalid in ({"continuationRef": "different"}, {"conversationId": "other"}, {"executor": "native"}):
                with self.assertRaises(HTTPException):
                    await conversation_turns.apply(None, self.task, {
                        **self.body, "executor": "dispatch", "continuationRef": "original", **invalid})
            body = {**self.body, "executor": "dispatch", "continuationRef": "original"}
            receipt = await conversation_turns.apply(None, self.task, body)
            self.assertEqual(receipt["continuationRef"], "original")
            self.assertEqual(self.task.work_routing["reworkPending"], pending)
            await conversation_turns.apply(None, self.task, {**body, "action": "start"})
            await conversation_turns.apply(None, self.task, {**body, "action": "complete"})
            self.assertEqual(self.task.work_routing["conversationTurn"]["state"], "completed")
            self.assertEqual(self.task.work_routing["reworkPending"], pending)

    async def test_prepare_persists_execution_submission_mode(self):
        result = await conversation_turns.apply(None, self.task, {
            **self.body, "action": "prepare", "executionSubmissionMode": "manual",
        })
        self.assertEqual(result["state"], "queued")
        self.assertEqual(self.task.work_routing["executionSubmissionMode"], "manual")
    async def test_empty_submission_mode_defaults_to_manual_without_output_contract(self):
        result = await self.apply("prepare")
        self.assertEqual(result["state"], "queued")
        self.assertEqual(self.task.work_routing["executionSubmissionMode"], "manual")
    async def test_empty_submission_mode_defaults_to_auto_with_output_contract(self):
        self.task.work_routing = {"outputContract": {"kind": "office-artifact"}}
        result = await self.apply("prepare")
        self.assertEqual(result["state"], "queued")
        self.assertEqual(self.task.work_routing["executionSubmissionMode"], "auto")
    async def test_completed_turn_is_not_automatic_business_acceptance(self):
        await self.apply("prepare");await self.apply("start");result=await self.apply("complete")
        self.assertEqual(result["state"],"completed")
        task_status.mark.assert_awaited_once_with(None,self.task,"doing",why="需求开始执行")
    async def test_workflow_cannot_be_silently_downgraded(self):
        self.task.work_routing={"selectedStrategy":"workflow"}
        with self.assertRaises(HTTPException):await self.apply("prepare")
    async def test_explicit_native_choice_replaces_idle_route_atomically_and_keeps_evidence(self):
        self.task.work_routing={"selectedStrategy":"workflow", "workflowBindingId":"old-flow",
            "selectedWorkflowBindingId":"old-flow", "outputContract":{"kind":"documents"},
            "executionContext":{"strategy":"workflow","runner":{"mode":"remote"}},
            "conversationTurn":{"state":"cancelled","conversationId":"old","turnId":"old"}}
        result=await conversation_turns.apply(None,self.task,{**self.body,
            "executionChoice":"native","agentId":"local:pi"})
        self.assertEqual(result["state"],"queued")
        self.assertEqual(self.task.work_routing["selectedStrategy"],"direct")
        self.assertFalse(self.task.work_routing.get("workflowBindingId"))
        self.assertFalse(self.task.work_routing.get("selectedWorkflowBindingId"))
        self.assertEqual(self.task.work_routing["outputContract"],{"kind":"documents"})
        self.assertEqual(self.task.work_routing["executionContext"]["agent"]["id"],"local:pi")
        events=[call.args[2] for call in task_events.record.call_args_list]
        self.assertIn("execution.choice",events)
    async def test_native_reselection_never_overrides_running_owners_or_completed_receipts(self):
        for blocker in ("lease","workflow","dispatch","completed","doing"):
            with self.subTest(blocker=blocker):
                self.task.status="doing" if blocker=="doing" else "todo"
                self.task.work_routing={"selectedStrategy":"workflow","workflowBindingId":"old-flow"}
                if blocker=="completed":self.task.work_routing["conversationTurn"]={"state":"completed"}
                conversation_turns._workflow_starting.return_value=blocker=="lease"
                task_status.engine_owns.return_value={"t"} if blocker=="workflow" else set()
                dispatch_attempts.existing.return_value={"ref":"active"} if blocker=="dispatch" else None
                before=dict(self.task.work_routing)
                with self.assertRaises(HTTPException):
                    await conversation_turns.apply(None,self.task,{**self.body,
                        "executionChoice":"native","agentId":"local:pi"})
                self.assertEqual(self.task.work_routing,before)
    async def test_starting_workflow_blocks_native_prepare(self):
        conversation_turns._workflow_starting.return_value=True
        with self.assertRaises(HTTPException):await self.apply("prepare")
    async def test_other_dispatchers_cannot_take_an_active_turn(self):
        await self.apply("prepare")
        with self.assertRaises(ValueError):conversation_turns.ensure_available(self.task)
        await self.apply("cancel")
        conversation_turns.ensure_available(self.task)
    async def test_native_followup_has_a_new_turn_and_retries_do_not_repeat_completion(self):
        await self.apply("prepare");await self.apply("start");await self.apply("complete")
        count = task_events.record.call_count
        self.assertEqual((await self.apply("prepare"))["state"], "completed")
        self.assertEqual(task_events.record.call_count, count)
        self.body["turnId"]="explicit-followup"
        self.assertEqual((await self.apply("prepare"))["state"], "queued")
        self.assertEqual(task_events.record.call_count, count + 1)
        with self.assertRaises(HTTPException):
            await conversation_turns.apply(None, self.task, {**self.body, "turnId": "turn", "action": "complete"})
    async def test_completed_controlled_turn_still_rejects_repeated_execution(self):
        for executor in ("workflow", "dispatch"):
            with self.subTest(executor=executor):
                self.task.work_routing = {}
                self.body["executor"] = executor
                self.body["turnId"] = "controlled"
                await self.apply("prepare");await self.apply("start");await self.apply("complete")
                self.body["turnId"] = "new-controlled-submission"
                with self.assertRaises(HTTPException):await self.apply("prepare")
    async def test_terminal_receipt_cannot_be_restarted_and_stale_finish_rejected(self):
        await self.apply("prepare");await self.apply("cancel")
        with self.assertRaises(HTTPException):await self.apply("start")
        self.body["turnId"]="stale"
        with self.assertRaises(HTTPException):await self.apply("complete")
    async def test_controlled_executor_only_accepts_matching_head_turn(self):
        self.body["executor"]="workflow"
        self.task.work_routing={"selectedStrategy":"workflow"}
        await self.apply("prepare")
        with self.assertRaises(ValueError):conversation_turns.ensure_available(self.task,self.body,"workflow")
        await self.apply("start")
        conversation_turns.ensure_available(self.task,self.body,"workflow")
        with self.assertRaises(ValueError):conversation_turns.ensure_available(self.task,self.body,"dispatch")
        with self.assertRaises(ValueError):conversation_turns.ensure_available(self.task,{**self.body,"turnId":"stale"},"workflow")
    async def test_waiting_and_failure_are_not_completion(self):
        await self.apply("prepare");await self.apply("start")
        self.assertEqual((await self.apply("wait"))["state"],"waiting")
        self.assertEqual((await self.apply("fail"))["state"],"failed")
        conversation_turns._cancel_turn_review.assert_awaited_once_with(
            None, self.task, ref="conversation:conversation", turn_id="turn", actor="")

if __name__=="__main__":unittest.main()
