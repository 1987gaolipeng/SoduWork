"""Disposable acceptance Hub with real fanout and synthetic stalled WS sends.

The imported fixture requires a private soduwork-collab-e2e-* directory beneath
the system temporary directory before it imports production services. No
submission endpoint, notification publisher or timeout is replaced here.
"""
import asyncio
import time
from contextlib import asynccontextmanager

from tests.acceptance_browser_server import app, fixture
from app import models, automation_models
from app.realtime import hub
from sqlalchemy import select

registered = []
attempts = []


class SlowSocket:
    async def send_json(self, event):
        attempts.append({"at": time.time(), "type": event.get("type")})
        await asyncio.sleep(60)


async def disconnect_owned():
    for device, socket in registered:
        await hub.disconnect(device, socket)


fixture_lifespan = app.router.lifespan_context


@asynccontextmanager
async def slow_socket_lifespan(application):
    async with fixture_lifespan(application):
        try:
            yield
        finally:
            await disconnect_owned()


app.router.lifespan_context = slow_socket_lifespan


@app.post('/e2e/slow-sockets')
async def arm_slow_sockets():
    if registered:
        return {"ok": True, "registered": len(registered)}
    async with fixture.sessions() as session:
        for index in range(97):
            device = f'e2e-stalled-{index}'
            session.add(models.Client(id=device, name=device, user_ref='recipient'))
            socket = SlowSocket()
            hub._conns[device].add(socket)
            hub._users[socket] = 'recipient'
            registered.append((device, socket))
        await session.commit()
    return {"ok": True, "registered": len(registered)}


@app.get('/e2e/manual-state/{task_id}')
async def manual_state(task_id: str):
    async with fixture.sessions() as session:
        approvals = list(await session.scalars(select(automation_models.ApprovalRequest)
            .where(automation_models.ApprovalRequest.task_id == task_id)))
        artifacts = list(await session.scalars(select(automation_models.ArtifactVersion)
            .where(automation_models.ArtifactVersion.task_id == task_id)))
    return {"registered": len(registered), "socketAttempts": len(attempts),
            "approvalIds": [row.id for row in approvals],
            "approvalStates": [row.status for row in approvals],
            "artifactIds": [row.id for row in artifacts]}


@app.post('/e2e/slow-sockets/disarm')
async def disarm_slow_sockets():
    await disconnect_owned()
    return {"ok": True, "registered": len(registered), "socketAttempts": len(attempts)}
