"""Direct cloud entry using existing dispatch fences, tasks and execution sessions.

No native desktop session or workspace snapshot is needed. The durable Handoff
row is an internal start receipt, not another queue. Generic editable Task data
can never authorize remote routing or select input objects.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import unicodedata
import uuid

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from ..agent_catalog import AGENTS
from ..config import get_settings
from ..conversation_handoff_models import ConversationHandoff as Handoff
from ..models import Attachment, Task
from . import conversation_handoffs as handoffs, storage
from . import cloud_code_delivery

MAX_FILES = 20
MAX_TOTAL_BYTES = 96 * 1024 * 1024


def clean_options(raw):
    if not isinstance(raw, dict) or set(raw) - {
        "sessionId", "agentId", "model", "title", "text", "requiredSkills"
    }:
        raise HTTPException(400, "云端会话选项不正确；不能指定本地目录、执行机或额外执行配置")
    out = {}
    for key, limit in (("sessionId", 160), ("agentId", 80), ("model", 200),
                       ("title", 200), ("text", 200000)):
        value = raw.get(key, "")
        if not isinstance(value, str) or len(value) > limit or "\0" in value:
            raise HTTPException(400, "云端会话字段不正确：" + key)
        out[key] = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", out["sessionId"]):
        raise HTTPException(400, "云端会话编号格式不正确")
    if out["agentId"] not in AGENTS:
        raise HTTPException(422, "当前服务尚未配置此 Agent 的云端执行支持")
    if not out["text"]:
        raise HTTPException(400, "请输入云端会话的第一条消息")
    required = raw.get("requiredSkills", [])
    if not isinstance(required, list) or len(required) > 100 or any(
            not isinstance(item, str) or not item or len(item) > 160 for item in required):
        raise HTTPException(400, "云端会话技能列表不正确")
    if any(item.lower() in {"computer-use", "computer_use", "desktop", "local-desktop"} for item in required):
        raise HTTPException(409, "本机电脑操作技能不能用于云端会话")
    out["requiredSkills"] = sorted(set(required))
    return out


async def read_files(files):
    if len(files) > MAX_FILES:
        raise HTTPException(413, "云端会话最多可附加 20 个文件")
    result, names, total = [], set(), 0
    limit = min(MAX_TOTAL_BYTES, get_settings().attach_max_mb * 1024 * 1024)
    for upload in files:
        name = unicodedata.normalize("NFC", str(upload.filename or ""))
        if (not name or len(name) > 200 or name != name.strip() or name.endswith(".")
                or name in {".", ".."} or re.search(r'[\\/:*?"<>|\x00-\x1f\x7f]', name)
                or re.fullmatch(r"(?i)(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name)):
            raise HTTPException(400, "附件名称不正确，请只上传文件而不是目录路径")
        if name.casefold() in names:
            raise HTTPException(400, "附件包含重名文件，请重命名后再发送")
        names.add(name.casefold())
        content_type = str(upload.content_type or "application/octet-stream")
        if len(content_type) > 200 or re.search(r"[\x00-\x1f\x7f]", content_type):
            raise HTTPException(400, "附件类型不正确")
        data = await upload.read(min(limit, MAX_TOTAL_BYTES - total) + 1)
        total += len(data)
        if len(data) > limit or total > MAX_TOTAL_BYTES:
            raise HTTPException(413, "附件超过单文件或总大小上限")
        if not data:
            raise HTTPException(400, "不能上传空文件")
        result.append({"name": name, "contentType": content_type, "data": data,
                       "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return result


async def _cleanup(objects):
    for key, backend in objects:
        await asyncio.to_thread(storage.delete, key, backend)


async def _resume(session, client, row, digest):
    if row.owner_user_id != client.user_ref:
        raise HTTPException(403, "设备归属已变更，不能访问原账号的云端会话")
    if row.phase == "aborted":
        return handoffs.public(row)
    if (row.source or {}).get("entryKind") != "cloud" or row.request_hash != digest:
        raise HTTPException(409, "此云端会话请求编号已用于另一条消息或附件，请使用原请求重试")
    return await handoffs.commit(session, client, row.transfer_id, row.sha256)


async def create(session, client, request_id, raw, uploads):
    user = await handoffs.owner(session, client)
    row_id = handoffs.identity(client.id, request_id)
    requested = clean_options(raw)
    inputs = await read_files(uploads)
    descriptor = {"options": requested, "files": [
        {key: item[key] for key in ("name", "contentType", "size", "sha256")} for item in inputs]}
    digest = hashlib.sha256(json.dumps(descriptor, sort_keys=True, ensure_ascii=False,
                                      separators=(",", ":")).encode()).hexdigest()
    old = await session.get(Handoff, row_id)
    if old:
        return await _resume(session, client, old, digest)
    source = {"entryKind": "cloud", "sessionId": requested["sessionId"],
              "adapterId": requested["agentId"], "modelName": requested["model"],
              "title": requested["title"] or requested["text"][:80], "goal": ""}
    code = cloud_code_delivery.context(requested["text"], str(uuid.uuid5(handoffs._NS, row_id + ":task")))
    if code:
        source.update(deliveryMode="git", codeDelivery=code["codeDelivery"])
    available = handoffs._automatic_targets(await handoffs.targets(session, client),
        requested["agentId"], source, requested["requiredSkills"])
    if not available:
        raise HTTPException(409, "暂时没有匹配 Agent、技能且可接单的云端环境，请在「我的 → 云端环境」检查连接、底座和负载")
    options = {"assigneeId": available[0]["id"], "agentId": requested["agentId"],
               "model": requested["model"], "instruction": requested["text"],
               "requiredSkills": requested["requiredSkills"], "personalPlugins": []}
    picked = await handoffs.destination(session, client, options, source)
    # Keep the runner's reachable host alongside the friendly display name.
    # Cloud website previews may report localhost:<port>; the desktop must
    # rewrite that loopback to the selected Runner host before opening it.
    options["targetSnapshot"] = {key: str(picked.get(key) or "") for key in
                                 ("name", "runnerName", "agentId", "modelMode", "runnerId", "host")}
    tid = str(uuid.uuid5(handoffs._NS, row_id + ":task"))
    objects, attachments, manifest = [], [], []
    committing = False
    try:
        for item in inputs:
            aid = str(uuid.uuid4())
            key = "cloud-inputs/" + row_id + "/" + aid + "/" + item["name"]
            backend = storage.backend_name()
            objects.append((key, backend))  # includes a possibly partial failed write
            backend = await asyncio.to_thread(storage.put, key, item["data"], item["contentType"])
            objects[-1] = (key, backend)
            attachments.append(Attachment(id=aid, task_id=tid, filename=item["name"],
                content_type=item["contentType"], size=item["size"], storage_key=key, backend=backend,
                uploaded_by=client.id, role="input", evidence_meta={"cloudRequestId": request_id}))
            manifest.append({"id": aid, **{k: item[k] for k in ("name", "contentType", "size", "sha256")}})
        options["inputs"] = manifest
        row = Handoff(id=row_id, owner_client_id=client.id, owner_user_id=user.id,
            transfer_id=request_id, task_id=tid, sha256="", request_hash=digest,
            storage_key="", backend="", options=options, source=source)
        task = Task(id=tid, owner_client_id=client.id, title=source["title"], note=requested["text"],
            kind="task", status="todo", origin="cloud-conversation", created_by=user.id,
            created_by_name=user.display_name or user.username,
            work_routing={"selectedStrategy": "direct", "requiredSkills": requested["requiredSkills"],
                          "cloudConversation": {"requestId": request_id, "sessionId": requested["sessionId"]}})
        session.add_all([row, task, *attachments])
        committing = True
        await session.commit()
    except IntegrityError:
        await session.rollback()
        await _cleanup(objects)
        await session.refresh(client)
        old = await session.get(Handoff, row_id, populate_existing=True)
        if old is None:
            raise
        return await _resume(session, client, old, digest)
    except BaseException:
        await session.rollback()
        if committing:
            # A database disconnect may lose only the commit acknowledgement.
            # Never remove files already referenced by the durable start fence.
            # If even this lookup fails, retain the objects for a safe retry.
            persisted = await session.get(Handoff, row_id, populate_existing=True)
            protected = {item.get("id") for item in (persisted.options or {}).get("inputs", [])} if persisted else set()
            objects = [(key, backend) for key, backend in objects
                       if key.split("/")[-2] not in protected]
        await _cleanup(objects)
        raise
    return await handoffs.commit(session, client, request_id, "")


async def dispatch_inputs(session, row, extra):
    """Re-read only the first message's authorized, immutable input snapshot."""
    selected = {str(item.get("name") or ""): item for item in extra.get("skills", [])}
    required = row.options.get("requiredSkills", [])
    if any(name not in selected for name in required):
        raise ValueError("云端会话所需技能已不可用，请恢复配置后重试")
    files = []
    for item in row.options.get("inputs", []):
        attachment = await session.get(Attachment, item["id"])
        if (not attachment or attachment.task_id != row.task_id
                or attachment.uploaded_by != row.owner_client_id or attachment.role != "input"):
            raise ValueError("云端会话附件已不存在或不属于本次消息，请重新发送")
        data = await asyncio.to_thread(storage.get, attachment.storage_key, attachment.backend)
        if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("云端会话附件已变化，请重新发送")
        files.append((item["name"], data, item["contentType"]))
    return files, {"dispatchId": handoffs.dispatch_id(row), "brief": row.options["instruction"],
        "conversationMode": "adaptive", "conversationUserText": row.options["instruction"],
        "agentExecution": extra.get("agentExecution", {}),
        "skills": [selected[name] for name in required], "requiredSkills": required,
        "requiredAgentCapabilities": ["files", "terminal"],
        **cloud_code_delivery.context(row.options["instruction"], row.task_id)}
