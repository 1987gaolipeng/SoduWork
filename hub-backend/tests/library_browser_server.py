"""Loopback-only library router fixture; never imports the Hub lifecycle."""
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

root = Path(os.environ["SODUWORK_LIBRARY_E2E_ROOT"]).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("soduwork-library-e2e-"):
    raise RuntimeError("An isolated temporary library directory is required")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (root / "library.sqlite").as_posix()
os.environ["LIBRARY_STORAGE_DIR"] = str(root / "objects")
os.environ["LIBRARY_STORAGE_BACKEND"] = "local"
# Override both environment and .env credentials/endpoints before Settings loads;
# this fixture must never probe a developer's configured remote storage.
for key in ("MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "LIBRARY_MINIO_ENDPOINT", "LIBRARY_MINIO_ACCESS_KEY", "LIBRARY_MINIO_SECRET_KEY",
            "LIBRARY_NFS_HOST", "LIBRARY_NFS_EXPORT"):
    os.environ[key] = ""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.api.library import router
from app.api.deliveries import router as deliveries_router
from app.db import Base, get_session
from app.deps import current_client
from app.library_models import LibraryFolder, LibraryItem
from app.models import Client

engine = create_async_engine(os.environ["DATABASE_URL"])
sessions = async_sessionmaker(engine, expire_on_commit=False)

@asynccontextmanager
async def lifespan(_app):
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[LibraryFolder.__table__, LibraryItem.__table__]))
    yield
    await engine.dispose()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["null"], allow_methods=["*"], allow_headers=["*"], expose_headers=["Content-Disposition"])
app.include_router(router)
app.include_router(deliveries_router)

async def session_override():
    async with sessions() as session:
        yield session

async def client_override(request: Request):
    owner = request.headers.get("X-Soduwork-Device", "e2e-alice")
    return Client(id=owner, user_ref=owner)

app.dependency_overrides[get_session] = session_override
app.dependency_overrides[current_client] = client_override

@app.get("/ready")
async def ready():
    return {"ok": True, "fixture": True}
