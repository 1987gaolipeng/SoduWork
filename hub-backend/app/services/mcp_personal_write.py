"""Save one connection conditionally without overwriting other entries or enabled state from a
stale editor snapshot.
"""
from __future__ import annotations

from fastapi import HTTPException
from . import mcp_servers


def _view(raw):
    return mcp_servers.mask(mcp_servers.personal_spec(raw))


async def save_one(session, client, body):
    if not isinstance(body, dict) or set(body) - {"server", "original"} or not isinstance(body.get("server"), dict):
        raise HTTPException(400, "请提交单个连接配置")
    raw = body["server"]
    original = body.get("original")
    if original is not None and not isinstance(original, dict):
        raise HTTPException(400, "原连接快照格式不正确")
    server_id = raw.get("id")
    if not isinstance(server_id, str) or not server_id or len(server_id) > 36:
        raise HTTPException(400, "连接标识无效，请重新打开编辑窗口")
    await session.refresh(client, with_for_update=True)
    rows = list(client.mcp_servers or [])
    matches = [(i, row) for i, row in enumerate(rows) if isinstance(row, dict) and row.get("id") == server_id]
    if len(matches) > 1:
        raise HTTPException(409, "连接标识重复，请先刷新目录")
    old = matches[0][1] if matches else None
    if original is not None:
        if old is None or original.get("id") != server_id:
            raise HTTPException(409, "连接已删除或发生变化，请重新打开编辑窗口")
        try:
            unchanged = _view(original) == _view(old)
        except (ValueError, TypeError):
            raise HTTPException(400, "原连接快照无效，请重新打开编辑窗口") from None
        if not unchanged:
            raise HTTPException(409, "连接已在其他位置修改，请重新打开后再保存")
        if mcp_servers.is_builtin(old):
            raise HTTPException(403, "SoduWork 内置连接器只能启用或停用")
    try:
        clean = mcp_servers.personal_spec(mcp_servers.restore(raw, old or {}))
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    from . import connector_oauth
    try:
        await connector_oauth.validate_binding(session, client, clean)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not clean["name"]:
        raise HTTPException(400, "请填写连接名称")
    # Use a stable random ID for creation so retries after lost responses identify the same request.
    if old is not None and original is None:
        if clean == mcp_servers.personal_spec(old):
            return clean
        raise HTTPException(409, "此连接已保存，请刷新后编辑")
    if old is None and len(rows) >= mcp_servers._PERSONAL_MAX:
        raise HTTPException(409, "个人连接最多 20 个，不会截断已有配置")
    if any(isinstance(row, dict) and row.get("id") != server_id and str(row.get("name") or "").casefold() == clean["name"].casefold() for row in rows):
        raise HTTPException(409, "个人连接名称重复，请使用其他名称")
    company = {row["name"].casefold() for row in await mcp_servers.load(session)}
    if clean["name"].casefold() in company and (old or {}).get("name") != clean["name"]:
        raise HTTPException(409, "公司已有同名连接，请直接使用公司连接或修改名称")
    if old is None:
        rows.append(clean)
    else:
        rows[matches[0][0]] = clean
    # Preserve legacy or hidden entries; this endpoint does not change the organization-enabled list.
    await connector_oauth.release_removed(session, list(client.mcp_servers or []), rows)
    client.mcp_servers = rows
    return clean
