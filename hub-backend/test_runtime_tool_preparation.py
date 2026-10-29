"""Pi SDK partials stay small and never become executed-tool evidence.

Exercises the real Runner parser/journal and Hub SQLite ingestion/read-back.
No model, business database, live Runner, or artifact storage is contacted.
"""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app.services import (execution_event_policy, execution_policy, local_base,
                          local_dialogue_outcome, local_stream, runtime_messages)


def partial(identity="write-1", tool="write", args=None, *, event="toolcall_delta", index=1):
    # pi-ai AssistantMessageEvent: contentIndex addresses the partial content
    # block; delta alone is not valid JSON and must never be reparsed by the UI.
    call = {"type": "toolCall", "id": identity, "name": tool,
            "arguments": args if args is not None else {"path": "result.html"}}
    return {"type": "message_update", "assistantMessageEvent": {
        "type": event, "contentIndex": index, "delta": 'arbitrary invalid json',
        "partial": {"role": "assistant", "content": [
            {"type": "text", "text": "about to write"}, call]}}}


def call_end(identity="write-1", tool="write", path="result.html"):
    return {"type": "message_update", "assistantMessageEvent": {
        "type": "toolcall_end", "contentIndex": 1,
        "toolCall": {"type": "toolCall", "id": identity, "name": tool,
                     "arguments": {"path": path, "content": "file body"}}}}


def start(identity="write-1", tool="write", path="result.html"):
    return {"type": "tool_execution_start", "toolCallId": identity,
            "toolName": tool, "args": {"path": path, "content": "file body"}}


def end(identity="write-1", tool="write"):
    return {"type": "tool_execution_end", "toolCallId": identity,
            "toolName": tool, "isError": False,
            "result": {"content": [{"type": "text", "text": "success"}]}}


def parse(message, run):
    rows = runtime_messages.augment(message, run, local_stream._items_from(message, run))
    execution_event_policy.tag_source_ids(message, rows)
    rows = execution_event_policy.filter_new(run, rows)
    run.setdefault("lines", []).extend(rows)
    return rows


class PreparationTests(unittest.TestCase):
    def test_long_content_writes_only_two_small_preparation_events(self):
        ref = "partial-file-fixture"
        run = {"cli": "pi", "lines": [], "segment": 1, "round": 1,
               "state": "running", "conversationMode": "adaptive", "turnStartSeq": 0,
               "executionPolicy": {"maxVerificationCommands": 0}}
        with tempfile.TemporaryDirectory(prefix="tool-preparing-") as directory, \
                patch.object(local_base, "_STORE", directory), \
                patch.dict(local_base._RUNS, {ref: run}), \
                patch.object(local_stream, "_append_raw") as raw:
            term = {}
            local_stream._on_line(ref, json.dumps(partial(args={}, event="toolcall_start")), term)
            for n in range(1, 101):
                args = {"path": "result.html", "content": "secret-body:" + "x" * (2048 * n),
                        "newText": "never expose", "command": "npm test"}
                local_stream._on_line(ref, json.dumps(partial(args=args)), term)
            saved = local_base._read_events(ref)
            self.assertEqual(len(saved), 2)
            self.assertEqual([x["phase"] for x in saved], ["preparing", "preparing"])
            self.assertEqual(saved[-1]["arguments"], {"path": "result.html"})
            journal = Path(directory, ref, "events.jsonl").read_text(encoding="utf-8")
            self.assertLess(len(journal), 1200)
            self.assertNotIn("secret-body", journal)
            self.assertNotIn("newText", journal)
            self.assertEqual(raw.call_count, 1)  # Existing delta raw-log safeguard.
            self.assertEqual(run["executionPolicyState"], {})
            self.assertNotIn("usage", run)
            self.assertEqual(local_dialogue_outcome.failure(run, {})["kind"], "execution_no_output")
            local_base._save_meta(ref)
            meta = json.loads(Path(directory, ref, "meta.json").read_text(encoding="utf-8"))
            self.assertNotIn("_toolPreparation", meta)

    def test_only_explicit_file_tools_and_real_partial_content_index(self):
        for tool in ("read", "write", "edit", "delete", "ReadFile", "write_file", "remove_file"):
            with self.subTest(tool=tool):
                self.assertEqual(parse(partial(tool=tool), {})[0]["tool"], tool)
        for tool in ("bash", "exec", "browser", "mcp__write_email", "write_lots", ""):
            self.assertEqual(parse(partial(tool=tool), {}), [])
        for index in (0, -1, 2, "1", True, None):
            self.assertEqual(parse(partial(index=index), {}), [])
        self.assertEqual(parse(partial(identity=""), {}), [])
        self.assertEqual(parse({"type": "message_update", "assistantMessageEvent": {
            "type": "toolcall_delta", "delta": '{"path":"a.md"}'}}, {}), [])

    def test_path_name_changes_and_parallel_ids_do_not_hide_reverted_paths(self):
        run = {}
        rows = []
        for identity, tool, path in [("a", "read", "a.md"), ("b", "edit", "b.md"),
                                    ("a", "write", "a.md"), ("a", "write", "b.md"),
                                    ("a", "write", "a.md")]:
            rows += parse(partial(identity, tool, {"path": path}), run)
        self.assertEqual(len(rows), 5)
        self.assertEqual(len({x["_sourceId"] for x in rows}), 5)
        self.assertEqual(rows[-1]["text"], "a.md")
        self.assertEqual(parse(partial("a", "write", {"path": "a.md", "content": "new"}), run), [])
        cancelled = parse({"type": "agent_settled"}, run)
        self.assertEqual({x["callId"] for x in cancelled}, {"a", "b"})
        self.assertTrue(all(x["phase"] == "cancelled" for x in cancelled))

    def test_tool_end_then_execution_start_produces_one_do_and_one_output(self):
        run = {}
        for message in [partial(), call_end(), start(), end(), partial(), call_end()]:
            parse(message, run)
        self.assertEqual([x["kind"] for x in run["lines"]], ["tool-preparing", "do", "out"])
        self.assertEqual(run["lines"][1]["arguments"], {"path": "result.html"})
        self.assertEqual(run["_toolPreparation"]["pending"], {})

    def test_execution_start_without_toolcall_end_is_real_fallback_once(self):
        run = {}
        for message in [partial(), start(), start(), call_end(), end()]:
            parse(message, run)
        self.assertEqual([x["kind"] for x in run["lines"]], ["tool-preparing", "do", "out"])
        direct = parse(start("no-partial", "read", "existing.md"), {})
        self.assertEqual(direct[0]["text"], "existing.md")
        self.assertEqual(direct[0]["kind"], "do")

    def test_malformed_start_does_not_suppress_later_valid_call(self):
        run = {}
        self.assertEqual(parse({"type": "tool_execution_start", "toolCallId": "write-1"}, run), [])
        self.assertEqual(parse(call_end(), run)[0]["kind"], "do")

    def test_execution_result_closes_pending_without_inventing_do(self):
        run = {}
        for message in [partial(), end(), partial(), {"type": "agent_settled"}]:
            parse(message, run)
        self.assertEqual([x["kind"] for x in run["lines"]], ["tool-preparing", "out"])
        self.assertEqual(run["_toolPreparation"]["pending"], {})

    def test_terminal_cancellation_and_successful_tool_use_wait(self):
        terminals = [{"type": name} for name in ("agent_settled", "agent_end", "error", "turn.failed")]
        terminals += [{"type": "message_end", "message": {"role": "assistant", "stopReason": reason}}
                      for reason in ("error", "aborted", "length", "max_tokens", "stop")]
        for terminal in terminals:
            with self.subTest(terminal=terminal):
                run = {}
                parse(partial(), run)
                parse({"type": "message_end", "message": {
                    "role": "assistant", "stopReason": "toolUse"}}, run)
                self.assertIn("write-1", run["_toolPreparation"]["pending"])
                rows = parse(terminal, run)
                self.assertEqual(rows[0]["phase"], "cancelled")
                self.assertEqual(parse(terminal, run), [])
                self.assertEqual(parse(partial(), run), [])
                self.assertFalse(any(x["kind"] in ("do", "out") for x in run["lines"]))

    def test_reused_id_in_new_round_or_segment_is_not_stale(self):
        for scope in ("round", "segment"):
            run = {"round": 1, "segment": 1}
            parse(partial(), run)
            parse({"type": "agent_settled"}, run)
            run[scope] = 2
            self.assertEqual(parse(partial(), run)[0]["phase"], "preparing")

    def test_history_snapshot_does_not_create_preparation_or_execution(self):
        history = {"role": "assistant", "stopReason": "toolUse", "content": [
            {"type": "toolCall", "id": "old", "name": "write",
             "arguments": {"path": "historical.md", "content": "saved body"}}]}
        run = {}
        for event in ({"type": "message_start", "message": history},
                      {"type": "message_end", "message": history},
                      {"type": "agent_end", "messages": [history]}):
            self.assertEqual(parse(event, run), [])
        self.assertEqual(run["_toolPreparation"]["pending"], {})

    def test_file_path_is_capped_and_public_fields_do_not_expose_body_or_commands(self):
        row = parse(partial(args={"file_path": "a" * 3000, "content": "secret"}), {})[0]
        self.assertEqual(len(row["text"]), 300)
        self.assertEqual(len(row["arguments"]["file_path"]), 1500)
        public = runtime_messages.public_fields({**row, "arguments": {
            "path": "a.md", "command": "secret command", "content": "secret body"}})
        self.assertEqual(public["arguments"], {"path": "a.md"})
        self.assertEqual(public["phase"], "preparing")
        self.assertNotIn("_sourceId", public)

    def test_preparation_is_not_a_policy_command_but_real_start_remains_guarded(self):
        policy = {"maxVerificationCommands": 0, "containerOrchestration": "forbid"}
        state = {}
        message = partial(args={"path": "a.md", "command": "docker build ."})
        row = parse(message, {})[0]
        self.assertEqual(execution_policy.command_events(message), [])
        self.assertIsNone(execution_policy.inspect(row, policy, state))
        self.assertEqual(state, {})
        real = {"type": "tool_execution_start", "toolCallId": "cmd", "toolName": "bash",
                "args": {"command": "docker build ."}}
        actual = execution_policy.command_events(real)[0]
        self.assertEqual(execution_policy.inspect(actual, policy, state)["code"], "container_orchestration")
        self.assertIsNone(execution_policy.inspect(actual, policy, state))
        self.assertEqual(state["commandsSeen"], 1)


    def test_plain_error_keeps_original_output_alongside_preparation_cancellation(self):
        run = {}
        parse(partial(), run)
        rows = parse({"type": "error", "message": "Provider unavailable; please retry"}, run)
        self.assertEqual([x["kind"] for x in rows], ["tool-preparing", "out"])
        self.assertEqual(rows[0]["phase"], "cancelled")
        self.assertEqual(rows[1]["text"], "Provider unavailable; please retry")
        self.assertEqual(run["_toolPreparation"]["pending"], {})
        self.assertFalse(any(x["kind"] in ("usage", "do") for x in rows))
        self.assertNotIn("additional", run["_messageStream"])

    def test_turn_failed_retains_generic_error_and_cancels_preparation_once(self):
        ref = "preparing-error-fixture"
        run = {"cli": "pi", "lines": [], "segment": 1, "state": "running", "metaAt": float("inf")}
        with patch.dict(local_base._RUNS, {ref: run}), patch.object(local_stream, "_append_raw"), \
                patch.object(local_stream, "_append_events"), patch.object(local_stream, "_save_meta"):
            term = {}
            local_stream._on_line(ref, json.dumps(partial()), term)
            local_stream._on_line(ref, json.dumps({"type": "turn.failed", "error": {
                "message": "Upstream model rejected this request"}}), term)
            cancelled = [x for x in run["lines"] if x.get("phase") == "cancelled"]
            outputs = [x for x in run["lines"] if x["kind"] == "out"]
            self.assertEqual(len(cancelled), 1)
            self.assertEqual(len(outputs), 1)
            self.assertIn("Upstream model rejected this request", outputs[0]["text"])
            self.assertTrue(term["isError"])
            self.assertFalse(any(x["kind"] in ("usage", "do") for x in run["lines"]))
            self.assertNotIn("additional", run["_messageStream"])

    def test_message_error_preserves_settled_usage_and_does_not_leak_cancel_row(self):
        run = {}
        parse(partial(), run)
        rows = parse({"type": "message_end", "message": {"role": "assistant",
            "stopReason": "error", "usage": {"input": 10, "output": 4}}}, run)
        self.assertEqual([x["kind"] for x in rows], ["tool-preparing", "usage"])
        self.assertEqual(rows[0]["phase"], "cancelled")
        self.assertEqual(rows[1]["usage"]["totalTokens"], 14)
        self.assertEqual(parse({"type": "agent_settled"}, run), [])


class PreparationArchiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_incremental_ingestion_and_offline_replay_preserve_preparation_phase(self):
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from sqlalchemy import select
        from app import models, automation_models as am
        from app.services import execution_sessions
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(models.Base.metadata.create_all)
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            async with sessions() as session:
                session.add(models.Client(id="preparing-owner", secret="fixture-only"))
                task = models.Task(id="preparing-task", title="fixture", status="doing",
                                   owner_client_id="preparing-owner")
                session.add(task)
                session.add(am.ExecutionSession(ref="preparing-ref", task_id=task.id,
                    state="running", metadata_={"round": 1}))
                await session.commit()
                run = {}
                parse(partial(), run)
                parse({"type": "message_end", "message": {
                    "role": "assistant", "stopReason": "aborted"}}, run)
                for seq, row in enumerate(run["lines"], 1):
                    row.update(seq=seq, seg=1)
                    live = {"ok": True, "status": "running", "cli": "pi", "round": 1,
                            "items": [row], "seq": seq}
                    await execution_sessions.ingest_live_snapshot(session, task, "preparing-ref", live)
                    await execution_sessions.ingest_live_snapshot(session, task, "preparing-ref", live)
                    await session.commit()
            # Read using a new SQLAlchemy session, with no Runner or memory view.
            async with sessions() as session:
                replay = await execution_sessions.read_task(session, "preparing-task", "preparing-ref")
                rows = replay["items"]
                self.assertEqual(len(rows), 2)
                self.assertEqual([x["phase"] for x in rows], ["preparing", "cancelled"])
                self.assertTrue(all(x["kind"] == "tool-preparing" for x in rows))
                self.assertTrue(all(x["arguments"] == {"path": "result.html"} for x in rows))
                self.assertTrue(all(x["callId"] == "write-1" for x in rows))
                tail = await execution_sessions.read_task(session, "preparing-task", "preparing-ref", since=1)
                self.assertEqual([x["phase"] for x in tail["items"]], ["cancelled"])
                self.assertEqual(list((await session.execute(select(models.Attachment))).scalars()), [])
        finally:
            await engine.dispose()


if __name__ == "__main__":
    unittest.main()
