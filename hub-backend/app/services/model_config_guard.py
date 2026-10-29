"""Opaque configuration revisions and transactional model-edit locks."""
from fastapi import HTTPException
from sqlalchemy import select, update

from ..models import AppSetting, Client
from .model_runtime import fingerprint, lock_setting


def revision(row):
    if row is None:
        return "new"
    if isinstance(row, Client):
        values = {"id": row.id, "keys": row.model_keys or {}, "models": row.models or [],
                  "providers": (row.config or {}).get("modelProviders", [])}
    else:
        values = {column.key: getattr(row, column.key) for column in row.__table__.columns}
    # HMAC includes secret changes without exposing a dictionary-testable key hash.
    return fingerprint(values)


def verify(row, expected, *, allow_patch=False):
    verify_revision(revision(row), expected, allow_patch=allow_patch)


def verify_revision(actual, expected, *, allow_patch=False):
    if expected is None and allow_patch:
        return
    if expected is None:
        raise HTTPException(428, "请刷新模型配置后再保存；旧客户端请先升级。当前输入尚未保存")
    if expected != actual:
        raise HTTPException(409, "模型配置已在其他窗口更新。请保留当前输入，重新打开配置核对后再保存")


async def personal(session, client, expected=None, *, allow_patch=False):
    await session.execute(update(Client).where(Client.id == client.id).values(id=Client.id))
    await session.refresh(client)
    verify(client, expected, allow_patch=allow_patch)


async def catalog(session, table, identifier, expected):
    # Also serializes two attempts to CREATE the same identifier, and provider
    # deletion versus creation/editing of its child models.
    await lock_setting(session, "model_catalog_edit_lock_v1")
    row = await session.get(table, identifier, populate_existing=True)
    verify(row, expected)
    return row


async def setting_values(session, keys):
    rows = (await session.execute(select(AppSetting).where(AppSetting.key.in_(keys))
                                  .execution_options(populate_existing=True))).scalars().all()
    return {r.key: r.value or "" for r in rows}


async def defaults(session, keys, expected):
    await lock_setting(session, "model_default_edit_lock_v1")
    current = await setting_values(session, keys)
    verify_revision(fingerprint(current), expected)
