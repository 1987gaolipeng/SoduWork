"""Create a conversation directly on an authorized remote Runner."""
import json
import re

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile

from ..db import get_session
from ..deps import current_ai_client
from ..models import Task
from ..services import cloud_conversations as svc
from ..services import task_access

router = APIRouter(prefix="/api/v1/cloud-conversations", tags=["cloud-conversations"])


@router.post("/{request_id}")
async def create(request_id: str, options: str = Form(...),
                 files: list[UploadFile] = File(default=[]),
                 client=Depends(current_ai_client), session=Depends(get_session)):
    if len(options) > 250000:
        raise HTTPException(413, "云端会话说明过长")
    try:
        raw = json.loads(options)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "云端会话选项必须是 JSON 对象") from exc
    return await svc.create(session, client, request_id, raw, files)


@router.post("/{task_id}/branch")
async def branch(task_id: str, body: dict = Body(default_factory=dict),
                 client=Depends(current_ai_client), session=Depends(get_session)):
    """Continue a cloud conversation on another owned Runner as a new task.

    A Runner session is pinned to its original machine.  This endpoint makes
    that boundary explicit: it carries bounded, server-side transcript context
    into a new handoff after rechecking the current account's target roster.
    """
    task = await session.get(Task, task_id)
    if task is None or not task_access.is_owner(task, client):
        raise HTTPException(status_code=404, detail="conversation not found")
    if task.origin != "cloud-conversation":
        raise HTTPException(status_code=409, detail="only cloud conversations can be moved")
    from ..services import ai_exec, conversation_handoffs, execution_sessions
    handoff = await conversation_handoffs.dispatch_record(session, task_id)
    if (handoff is None or handoff.phase != "committed"
            or handoff.owner_user_id != client.user_ref or handoff.owner_client_id != client.id):
        raise HTTPException(status_code=409, detail="conversation handoff is not owned by this device")
    target_runner_id = str(body.get("targetRunnerId") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", target_runner_id):
        raise HTTPException(status_code=422, detail="a target Runner is required")
    request_id = str(body.get("requestId") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", request_id):
        raise HTTPException(status_code=422, detail="invalid branch request id")
    instruction = str(body.get("instruction") or "").strip()
    if not instruction or len(instruction) > 200_000 or "\0" in instruction:
        raise HTTPException(status_code=422, detail="instruction is required")
    requested_agent = str(body.get("agentId") or "").strip()
    requested_model = str(body.get("model") or "").strip()
    active = dict((handoff.receipt or {}).get("activeExecutionSelection") or {})
    agent_id = requested_agent or str(active.get("agentId") or handoff.options.get("agentId") or "")
    model = requested_model or str(active.get("modelName") or handoff.options.get("model") or "")
    if not agent_id:
        raise HTTPException(status_code=409, detail="current Agent is unavailable")
    if (handoff.options or {}).get("inputs"):
        raise HTTPException(status_code=409, detail="conversation attachments must be attached again on the new Runner")

    event = await ai_exec.last_dispatch_event(session, task_id)
    ref = str((event.detail if event else {}).get("ref") or (event.detail if event else {}).get("issueId") or "")
    cached = await execution_sessions.read_task(session, task_id, ref, 0, limit=1000) if ref else None
    items = list((cached or {}).get("items") or [])
    lines = []
    if task.note:
        lines.append("user: " + str(task.note)[:20_000])
    for item in items:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        kind = str(item.get("kind") or "assistant")
        role = "user" if kind in {"user", "prompt", "input"} else "assistant"
        lines.append(role + ": " + text[:20_000])
    prefix = "Read-only context from the original cloud conversation:"
    selected, total = [], 0
    limit = max(0, min(150_000, 190_000 - len(instruction)))
    for line in reversed(lines):
        if total + len(line) + 2 > limit:
            break
        selected.append(line)
        total += len(line) + 2
    selected.reverse()
    context = "\n\n".join([prefix] + (["[older context omitted]"] if len(selected) < len(lines) else []) + selected)
    text = (context + "\n\nContinuation request:\n" + instruction).strip()
    if len(text) > 200_000:
        text = instruction
    receipt = await svc.create(session, client, request_id, {
        "sessionId": "cloud-" + request_id,
        "agentId": agent_id,
        "model": model,
        "title": str((handoff.source or {}).get("title") or task.title or instruction[:80])[:200],
        "text": text,
        "userText": instruction,
        "requiredSkills": list(handoff.options.get("requiredSkills") or []),
        "targetRunnerId": target_runner_id,
    }, [])
    return {**receipt, "branch": {"sourceTaskId": task_id, "targetRunnerId": target_runner_id}}
