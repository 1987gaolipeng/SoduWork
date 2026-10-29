"""Authorize cloud conversation continuation on its original owned Runner."""
from __future__ import annotations

from fastapi import HTTPException

from . import conversation_handoffs, execution_selection, task_execution_model


async def prepare(session, client, ctx, handoff, raw=None):
    if not handoff:
        if raw is not None:
            raise HTTPException(409, "此任务不是可切换执行底座的个人云端会话")
        return ctx
    if (handoff.phase != "committed" or handoff.owner_client_id != client.id
            or handoff.owner_user_id != client.user_ref):
        raise HTTPException(409, "请先确认会话已由当前账号的云端接管")
    previous = (handoff.receipt or {}).get("activeExecutionSelection") or {
        "agentId": handoff.options.get("agentId") or
                   (handoff.options.get("targetSnapshot") or {}).get("agentId") or
                   str(handoff.options["assigneeId"]).rsplit(":", 1)[-1],
        "modelName": handoff.options.get("model", ""), "reasoningEffort": ""}
    try:
        chosen = execution_selection.normalize(raw if raw is not None else previous)
    except execution_selection.SelectionError as exc:
        raise HTTPException(422, str(exc)) from exc
    runner_id = str((handoff.options.get("targetSnapshot") or {}).get("runnerId") or "")
    if not runner_id:
        from .ai_remote import _runner_of_ref
        runner = _runner_of_ref(str((handoff.receipt or {}).get("ref") or
                                    (handoff.receipt or {}).get("issueId") or ""))
        runner_id = runner.id if runner else ""
    options = {**handoff.options, "assigneeId": "runner:" + runner_id + ":" + chosen["agentId"],
               "agentId": chosen["agentId"], "model": chosen["modelName"]}
    # Consent authorized only the initial local-to-Pi handoff. A subsequent
    # explicit turn selection has its own validation and must not be restricted
    # by (or mutate) that immutable initial consent receipt.
    options.pop("agentFallback", None)
    # destination rechecks current ownership, installations, skills, goal mode,
    # policy scope and managed-model authorization. Never move the workspace.
    picked = await conversation_handoffs.destination(session, client, options, handoff.source)
    if raw is not None:
        from . import runner_hub
        runner = runner_hub.get(runner_id)
        if not runner or "executionSelection1" not in getattr(runner, "caps", []):
            raise HTTPException(409, "此云端执行机尚不支持会话内切换，请先更新执行机")
    try:
        ctx, native = await task_execution_model.prepare(session, client, ctx, picked,
            chosen["modelName"], chosen["reasoningEffort"])
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    out = dict(ctx)
    for key in ("cfg", "localCfg"):
        cfg = dict(out.get(key) or {})
        cfg["local_cli"] = chosen["agentId"]
        cfg["codex_model"] = native.get("model", "") if chosen["agentId"] == "codex" else ""
        cfg["codex_reasoning_effort"] = native.get("reasoningEffort", "") if chosen["agentId"] == "codex" else ""
        # An admission ACK may precede native startup/cancellation. Carry the
        # last accepted choice until Runner confirms/applies it; otherwise a
        # failed startup followed by ordinary send would use the old executor.
        if raw is not None or (handoff.receipt or {}).get("activeExecutionSelection"):
            cfg["_executionSelection"] = chosen
        out[key] = cfg
    return out


async def accepted(session, handoff, result):
    chosen = result.get("acceptedSelection")
    if handoff and isinstance(chosen, dict) and result.get("ok"):
        # Keep the initial immutable options/hash intact for create retries.
        from sqlalchemy import select
        from ..conversation_handoff_models import ConversationHandoff
        handoff = await session.scalar(select(ConversationHandoff).where(
            ConversationHandoff.id == handoff.id).with_for_update().execution_options(populate_existing=True))
        revision = int(result.get("acceptedSelectionRevision") or 0)
        if revision <= int((handoff.receipt or {}).get("activeExecutionSelectionRevision") or 0):
            return
        handoff.receipt = {**(handoff.receipt or {}), "activeExecutionSelection": chosen,
                           "activeExecutionSelectionRevision": revision}
        await session.commit()
