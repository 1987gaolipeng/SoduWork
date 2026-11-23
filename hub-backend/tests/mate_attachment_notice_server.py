"""Isolated colleague-message fixture with three registered local devices."""
from contextlib import asynccontextmanager

from tests.library_notification_server import app, lifespan as library_lifespan, sessions, models


@asynccontextmanager
async def lifespan(application):
    async with library_lifespan(application):
        async with sessions() as session:
            for name in ("sender", "recipient", "other"):
                session.add(models.Client(id="fixture-device-" + name, user_ref=name,
                                          auth_state="active"))
            await session.commit()
        yield


app.router.lifespan_context = lifespan
