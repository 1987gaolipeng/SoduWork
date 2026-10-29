"""Client account sign-in endpoints return authorization references, never access or refresh
tokens.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import current_client
from ..models import Client
from ..services import connector_oauth as service, connector_oauth_registry as registry

class PrivateJSONResponse(JSONResponse):
    def __init__(self, content, status_code: int = 200, **kwargs):
        headers = {**(kwargs.pop("headers", None) or {}), "Cache-Control": "no-store"}
        super().__init__(content, status_code=status_code, headers=headers, **kwargs)


router = APIRouter(prefix="/mcp-servers/oauth", default_response_class=PrivateJSONResponse)


@router.get("/providers")
async def providers(client: Client = Depends(current_client)):
    return registry.catalog()


@router.post("/start")
async def start(body: dict = Body(default_factory=dict), client: Client = Depends(current_client),
                session: AsyncSession = Depends(get_session)):
    if set(body) - {"provider", "connectorId", "server"}:
        raise HTTPException(400, "授权请求包含不支持字段")
    try:
        result = await service.start(session, client, body.get("provider"), body.get("connectorId"), body.get("server"))
        await session.commit()
        return result
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@router.get("/status/{attempt_id}")
async def status(attempt_id: str, client: Client = Depends(current_client),
                 session: AsyncSession = Depends(get_session)):
    try:
        return await service.status(session, client, attempt_id)
    except ValueError:
        raise HTTPException(404, "授权不存在、已过期或不属于当前账号") from None


@router.post("/cancel/{attempt_id}")
async def cancel(attempt_id: str, client: Client = Depends(current_client),
                 session: AsyncSession = Depends(get_session)):
    try:
        result = await service.cancel(session, client, attempt_id)
        await session.commit()
        return result
    except ValueError:
        raise HTTPException(404, "授权不存在或不属于当前账号") from None


@router.get("/callback", response_class=HTMLResponse)
async def callback(state: str = Query("", max_length=256), code: str = Query("", max_length=8192),
                   error: str = Query("", max_length=200), session: AsyncSession = Depends(get_session)):
    try:
        connected = await service.finish(session, state, code, bool(error))
    except ValueError:
        connected = False
    text = "账号授权已完成，请返回 SoduWork。" if connected else "账号授权未完成，请返回 SoduWork 重新连接。"
    # Avoid external assets and interpolated provider values so callback codes cannot leak through Referer headers.
    return HTMLResponse('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>SoduWork</title>'
                        '<body><p>' + text + '</p></body></html>', headers={
                            "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"})
