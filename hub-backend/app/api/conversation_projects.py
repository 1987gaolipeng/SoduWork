"""Revision-checked sidebar edits; omission never deletes a project."""
import json
import re
import base64
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import current_client, identity_only
from ..models import Client
from ..account_conversation_models import AccountConversation, ConversationProject
from .account_conversations import _owner

router = APIRouter(prefix="/api/v1/conversation-projects", tags=["conversation-projects"])

async def _directory(session, owner):
    return list((await session.scalars(select(AccountConversation).where(
        AccountConversation.owner_user_id == owner))).all())

def _member_key(member):
    return "member:" + base64.urlsafe_b64encode(json.dumps(member, separators=(",", ":")).encode()).decode()

def _canonical(value, client, conversations, existing_members=()):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise HTTPException(422, "会话标识无效")
    if value.startswith("member:"):
        # Opaque identities preserve unsynchronized members on another device.
        # Only identities already in this account's project may be retained.
        member = next((m for m in existing_members if _member_key(m) == value), None)
        if member is None:
            raise HTTPException(422, "项目会话引用已变化，请刷新")
        return member
    if value.startswith("account:"):
        row = next((r for r in conversations if r.id == value[8:]), None)
        if row is None:
            raise HTTPException(404, "会话不存在")
        return {"client": row.source_client_id, "session": row.source_session_id}
    if value.startswith("task:") or value.startswith("cloud-task:"):
        return {"client": "", "session": "cloud-task:" + value.split(":", 1)[1]}
    # PC submits its own native identity. It cannot assign another device's
    # unsynchronized session or obtain any execution authority from a group.
    return {"client": client.id, "session": value}

def _json(row, client, conversations):
    ids = []
    for member in json.loads(row.members):
        native, source = member["session"], member["client"]
        if source == client.id or not source:
            ids.append(native)
        elif native.startswith("cloud-task:"):
            ids.append(native)
        else:
            conversation = next((c for c in conversations if c.source_session_id == native
                                 and c.source_client_id == source), None)
            ids.append("account:" + conversation.id if conversation else _member_key(member))
    return {"id": row.id, "name": row.name, "revision": row.revision,
            "deleted": row.deleted, "chatIds": list(dict.fromkeys(ids))}

@router.get("")
@identity_only
async def list_projects(client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    owner = _owner(client)
    conversations = await _directory(session, owner)
    rows = (await session.scalars(select(ConversationProject).where(
        ConversationProject.owner_user_id == owner).order_by(ConversationProject.id))).all()
    return {"items": [_json(row, client, conversations) for row in rows]}

@router.put("/{project_id}")
async def save_project(project_id: str, data: dict = Body(...), client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    owner = _owner(client)
    if not re.fullmatch(r"project-[\w-]{1,110}", project_id):
        raise HTTPException(422, "项目标识无效")
    name = str(data.get("name") or "").strip()
    if not name or len(name) > 120:
        raise HTTPException(422, "项目名称需要1至120个字")
    revision = data.get("revision")
    if type(revision) is not int or revision < 0:
        raise HTTPException(422, "缺少项目版本")
    values = data.get("chatIds", [])
    if not isinstance(values, list) or len(values) > 1000:
        raise HTTPException(422, "项目会话数量无效")
    conversations = await _directory(session, owner)
    existing = await session.get(ConversationProject, (owner, project_id))
    existing_members = json.loads(existing.members) if existing else []
    members = []
    for value in values:
        member = _canonical(value, client, conversations, existing_members)
        if member not in members:
            members.append(member)
    # Partial metadata edits preserve inaccessible/offline native identities.
    if existing and "chatIds" not in data:
        members = json.loads(existing.members)
    attrs = dict(name=name, revision=revision + 1, deleted=data.get("deleted") is True,
                 members=json.dumps(members, ensure_ascii=False))
    if existing:
        result = await session.execute(update(ConversationProject).where(
            ConversationProject.owner_user_id == owner, ConversationProject.id == project_id,
            ConversationProject.revision == revision).values(**attrs))
        if result.rowcount != 1:
            await session.rollback()
            raise HTTPException(409, "项目已在其他设备更新，请刷新后重试")
    else:
        if revision != 0:
            raise HTTPException(409, "项目版本已变化，请刷新后重试")
        session.add(ConversationProject(owner_user_id=owner, id=project_id, **attrs))
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "项目已在其他设备更新，请刷新后重试")
    row = await session.get(ConversationProject, (owner, project_id), populate_existing=True)
    from ..services.client_domain_events import account_changed
    await account_changed(session, owner, "conversation-projects")
    return _json(row, client, conversations)
