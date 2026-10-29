"""Loopback notification fixture using production routes and snapshot storage."""
from contextlib import asynccontextmanager

from fastapi import Request
from sqlalchemy import select, func

from tests.library_browser_server import app, root, engine, sessions, Base, get_session
from app import models
from app.api.clients import router as clients_router
from app.api.attachments import router as attachments_router
from app.deps import current_client
from app.library_models import LibraryItem
from app.services import storage, team

storage._LOCAL_DIR = str(root / "notification-objects")
storage.backend_name = lambda: "local"


@asynccontextmanager
async def lifespan(_app):
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        for name in ("sender", "recipient", "other"):
            session.add(models.User(id=name, username=name, display_name=name, org_id="fixture-org", is_active=True))
        await session.commit()
    yield
    await engine.dispose()


async def client_override(request: Request):
    # The only identities accepted by this isolated server are fixture accounts.
    user = request.headers.get("Authorization", "").removeprefix("Device fixture-")
    if user not in {"sender", "recipient", "other"}:
        from fastapi import HTTPException
        raise HTTPException(401, "Fixture identity required")
    return models.Client(id="fixture-device-" + user, user_ref=user)


async def fixture_company_members(session, _me):
    return list((await session.scalars(select(models.User))).all())


team._company_members = fixture_company_members
app.router.lifespan_context = lifespan
app.dependency_overrides[current_client] = client_override
app.include_router(clients_router)
app.include_router(attachments_router)


@app.get("/fixture/counts")
async def counts():
    async with sessions() as session:
        return {model.__name__: await session.scalar(select(func.count()).select_from(model))
                for model in (LibraryItem, models.Attachment, models.MateMessage)}
