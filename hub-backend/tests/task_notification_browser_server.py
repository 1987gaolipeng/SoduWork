"""Assignment notification integration fixture: isolated HTTP, SQLite and WS."""
from contextlib import asynccontextmanager

from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect

from tests.collaboration_browser_server import app, sessions
from app import models
from app.api import tasks
from app.deps import current_client
from app.realtime import hub

app.include_router(tasks.router)
original_lifespan = app.router.lifespan_context
devices = {"e2e-sender", "e2e-recipient", "e2e-recipient-other", "e2e-other"}


@asynccontextmanager
async def lifespan(application):
    async with original_lifespan(application):
        async with sessions() as session:
            session.add(models.Client(id="e2e-recipient-other", user_ref="recipient", auth_state="active"))
            await session.commit()
        yield


app.router.lifespan_context = lifespan


async def identity(request: Request):
    key = request.headers.get("X-Soduwork-Device", "")
    if key not in devices:
        raise HTTPException(401, "Unknown isolated identity")
    async with sessions() as session:
        return await session.get(models.Client, key)


app.dependency_overrides[current_client] = identity


@app.websocket("/fixture/ws/{device}")
async def socket(ws: WebSocket, device: str):
    # Authentication is the fixture boundary; delivery uses production Hub.
    if device not in devices:
        await ws.close(code=4401)
        return
    if not await hub.connect(device, ws):
        await ws.close(code=4403)
        return
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(device, ws)
