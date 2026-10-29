# -*- coding: utf-8 -*-
"""Regression checks for task follow-up delivery and transcript persistence."""
from pathlib import Path
import asyncio
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, ".")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./.smoke-ai-followup.db"

from app.services import ai_exec, ai_remote, local_stream, runner_hub  # noqa: E402


async def verify_followup_access() -> None:
    from fastapi import HTTPException
    from app.api import tasks
    from app.services import conversation_handoffs

    client = SimpleNamespace(id="collaborator")
    session = object()
    # An ordinary shared task keeps the established organization visibility rule.
    visible = AsyncMock(return_value=SimpleNamespace(owner_client_id="task-owner"))
    dispatch = SimpleNamespace(detail={"ref": "runner:shared:pi"})
    with patch.object(tasks, "_view_task", visible), \
         patch.object(ai_exec, "last_dispatch_event", AsyncMock(return_value=dispatch)), \
         patch.object(ai_exec, "load", AsyncMock(return_value={})), \
         patch.object(conversation_handoffs, "dispatch_record", AsyncMock(return_value=None)) as handoff, \
         patch.object(ai_exec, "say_sync", return_value={"ok": True}) as send:
        result = await tasks.ai_say_task("task", {"text": "Follow up"}, client, session)
        assert result["ok"] is True
        visible.assert_awaited_once_with(session, client, "task")
        send.assert_called_once()
        send.reset_mock()
        # Transferred personal conversations require the transferring identity,
        # in addition to task visibility, before using its model credentials.
        handoff.return_value = SimpleNamespace(phase="committed", owner_client_id="task-owner")
        try:
            await tasks.ai_say_task("task", {"text": "Follow up"}, client, session)
        except HTTPException as exc:
            assert exc.status_code == 409
        else:
            raise AssertionError("A collaborator must not continue another user's cloud conversation")
        send.assert_not_called()


def main() -> None:
    old_by_ref = ai_exec._by_ref
    old_local_comment = ai_exec._ai_local.comment_sync
    old_record = local_stream.record_user_sync
    order = []
    try:
        ai_exec._by_ref = lambda _ref: ai_exec._ai_local
        local_stream.record_user_sync = lambda ref, value: order.append(("record", ref, value)) or {"ok": True}
        ai_exec._ai_local.comment_sync = lambda _cfg, ref, value: order.append(("comment", ref, value)) or {
            "ok": True, "queued": True}

        result = ai_exec.say_sync({"name": "local", "cfg": {}}, "local:test", "follow up")
        assert result["ok"] is True and result["queued"] is True
        assert [row[0] for row in order] == ["record", "comment"]

        order.clear()
        result = ai_exec.say_sync(
            {"name": "local", "cfg": {}}, "local:test", "system reminder", record_user=False)
        assert result["ok"] is True
        assert [row[0] for row in order] == ["comment"]

        ai_exec._ai_local.comment_sync = lambda *_args, **_kwargs: None
        invalid = ai_exec.say_sync({"name": "local", "cfg": {}}, "local:test", "bad receipt")
        assert invalid["ok"] is False and invalid["error"]
    finally:
        ai_exec._by_ref = old_by_ref
        ai_exec._ai_local.comment_sync = old_local_comment
        local_stream.record_user_sync = old_record

    old_runner_of_ref = ai_remote._runner_of_ref
    old_call_sync = runner_hub.call_sync
    sent = {}
    try:
        runner = object()
        ai_remote._runner_of_ref = lambda _ref: runner

        def fake_call(got_runner, op, data, timeout=0):
            sent.update({"runner": got_runner, "op": op, "data": data, "timeout": timeout})
            return {"ok": True, "data": {"ok": True}}

        runner_hub.call_sync = fake_call
        result = ai_remote.comment_sync(
            {"token": "safe", "_recordUser": True}, "runner:r1:pi", "remote follow up")
        assert result["ok"] is True
        assert sent["runner"] is runner and sent["op"] == "job.comment"
        assert sent["data"]["recordUser"] is True
        assert sent["data"]["cfg"] == {"token": "safe"}
    finally:
        ai_remote._runner_of_ref = old_runner_of_ref
        runner_hub.call_sync = old_call_sync

    source = Path("app/api/tasks.py").read_text(encoding="utf-8")
    route = source[source.index("async def ai_say_task("):source.index("@router.post(\"/tasks/{tid}/ai-remind\")")]
    assert "_view_task(session, client, tid)" in route
    assert "str(r.get(\"error\"))" not in route
    asyncio.run(verify_followup_access())
    print("ai follow-up smoke: delivery, shared task access and cloud conversation identity passed")


if __name__ == "__main__":
    main()
