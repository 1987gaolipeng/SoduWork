"""Repair missing turn events through one bounded, authorized archive read per poll."""
import asyncio
import json

from sqlalchemy import exists, func, select
from sqlalchemy.orm import aliased

from .. import automation_models as am, im_models as im
from . import execution_sessions, im_connections as connections, runner_hub

PAGE_SIZE = 32
MAX_PAGE_BYTES = 8 * 1024 * 1024


async def first_missing(session, row, start, end):
    count, first = (await session.execute(select(func.count(), func.min(am.ExecutionEvent.seq)).where(
        am.ExecutionEvent.session_id == row.id,
        am.ExecutionEvent.seq > start, am.ExecutionEvent.seq <= end))).one()
    if count == end - start:
        return None
    if first != start + 1:
        return start + 1
    following = aliased(am.ExecutionEvent)
    previous = await session.scalar(select(func.min(am.ExecutionEvent.seq)).where(
        am.ExecutionEvent.session_id == row.id, am.ExecutionEvent.seq > start, am.ExecutionEvent.seq < end,
        ~exists(select(following.id).where(following.session_id == row.id,
            following.seq == am.ExecutionEvent.seq + 1))))
    return previous + 1 if previous is not None else start + 1


async def _authorized(session, row, inbox, binding):
    await session.refresh(binding)
    await session.refresh(row)
    if (not binding.enabled or binding.id != inbox.binding_id or binding.connection_id != inbox.connection_id
            or binding.task_id != inbox.task_id or row.task_id != inbox.task_id
            or row.runner_id != binding.runner_id or row.ref != inbox.ref):
        return None
    connection = await session.get(im.IMConnection, inbox.connection_id, populate_existing=True)
    await connections.target(session, connection, binding.task_id, binding.runner_id)
    live = runner_hub.get(binding.runner_id)
    return live if live and live.id == row.runner_id else None


async def _read(session, row, inbox, binding, since, limit):
    inbox._im_archive_probe = None
    live = await _authorized(session, row, inbox, binding)
    if live is None:
        return None
    ref, task_id = row.ref, row.task_id
    try:
        async with asyncio.timeout(20):
            result = await live.call("job.session", {"ref": ref, "since": since, "limit": limit}, timeout=15)
    except (Exception, TimeoutError):
        return None
    # Reuse this poll's read for admission diagnostics instead of issuing a second RPC.
    inbox._im_archive_probe = result
    if not isinstance(result, dict) or result.get("ok") is not True:
        return None
    data = result.get("data")
    if (not isinstance(data, dict) or data.get("ok") is not True
            or data.get("ref") != ref or data.get("taskId") != task_id):
        if isinstance(data, dict) and (data.get("ref") not in (None, ref) or data.get("taskId") not in (None, task_id)):
            inbox._im_archive_probe = None
        return None
    items = data.get("items")
    if not isinstance(items, list) or len(items) > limit:
        return None
    try:
        if len(json.dumps(items, ensure_ascii=False).encode("utf-8")) > MAX_PAGE_BYTES:
            return None
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return None
    for offset, item in enumerate(items):
        if not isinstance(item, dict) or type(item.get("seq")) is not int or item["seq"] != since + offset + 1:
            return None
    if await _authorized(session, row, inbox, binding) is not live:
        return None
    return data


async def repair(session, row, inbox, binding, start, end, missing):
    data = await _read(session, row, inbox, binding, missing - 1, min(PAGE_SIZE, end - missing + 1))
    if not data or not data["items"]:
        return False
    items = data["items"]
    for item in items:
        if item.get("admissionKey") != inbox.admission_key:
            return False
        if item.get("kind") == "turn-end" and (item["seq"] != end or item.get("admissionStartSeq") != start):
            return False
    # A newer desktop turn may own the current snapshot. Only the requested,
    # individually correlated archive events are imported; its state is untouched.
    await execution_sessions.ingest_event_page(session, row, items)
    return await first_missing(session, row, start, end) is None


def _start(value):
    return value if type(value) is int and value >= 0 else None


async def recover_terminal(session, row, inbox, binding):
    """Recover a lost final page, including when a later desktop turn is active."""
    meta = row.metadata_ or {}
    recovery = meta.get("imArchiveRecovery") or {}
    if recovery.get("admissionKey") != inbox.admission_key:
        recovery = {}
    start = _start(recovery.get("start"))
    if start is None and meta.get("admissionKey") == inbox.admission_key:
        start = _start(meta.get("admissionStartSeq"))
    if start is None:
        first = (await session.scalars(select(am.ExecutionEvent).where(
            am.ExecutionEvent.session_id == row.id,
            am.ExecutionEvent.detail["admissionKey"].as_string() == inbox.admission_key)
            .order_by(am.ExecutionEvent.seq).limit(1))).first()
        start = _start((first.detail or {}).get("admissionStartSeq")) if first else None
    if start is not None:
        end = max(int(row.seq or 0), start + 1)
        missing = await first_missing(session, row, start, end)
        since = missing - 1 if missing is not None else end
    else:
        # This is only a scan cursor. Never infer a turn boundary from the old
        # heartbeat watermark; a correlated native event or snapshot must supply it.
        since = _start(recovery.get("cursor"))
        if since is None:
            since = max(0, int(inbox.base_seq or 0))
    data = await _read(session, row, inbox, binding, since, PAGE_SIZE)
    if data is None:
        return
    candidate = _start(data.get("admissionStartSeq")) if data.get("admissionKey") == inbox.admission_key else None
    own = [item for item in data["items"] if item.get("admissionKey") == inbox.admission_key]
    if candidate is None and own:
        candidate = _start(own[0].get("admissionStartSeq"))
    if candidate is not None:
        if start is not None and candidate != start:
            return
        start = candidate
    items = []
    if start is not None:
        for item in data["items"]:
            if item["seq"] <= start:
                continue
            if item.get("admissionKey") != inbox.admission_key:
                break
            if _start(item.get("admissionStartSeq")) != start:
                return
            items.append(item)
            if item.get("kind") == "turn-end":
                break
        await execution_sessions.ingest_event_page(session, row, items)
        if items:
            row.seq = max(int(row.seq or 0), items[-1]["seq"])
    row.metadata_ = {**(row.metadata_ or {}), "imArchiveRecovery": {
        "admissionKey": inbox.admission_key, "start": start,
        "cursor": data["items"][-1]["seq"] if data["items"] else since}}
