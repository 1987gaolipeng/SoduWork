"""Isolated real-auth fixture shared by API and browser Skill regression tests."""
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ["CLUSTER_REDIS_URL"] = ""
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.db import Base, get_session
from app import models, automation_models, project_context_models
from app.api import capabilities, tasks
from app.auth import sign_token
from app.services import device_auth, skill_packages, skills

async def fixture(root):
    root = Path(root)
    if (root / "test.db").exists():
        raise ValueError("The isolated API fixture requires a new database file")
    engine = create_async_engine("sqlite+aiosqlite:///" + str(root / "test.db"))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        # Keep fresh DDL atomic and avoid repeated discovery and fsync for every table.
        raw = await connection.get_raw_connection()
        if not raw.driver_connection.in_transaction:
            await connection.exec_driver_sql("BEGIN")
        await connection.run_sync(Base.metadata.create_all, checkfirst=False)
    app = FastAPI()
    async def database():
        async with sessions() as session:
            yield session
    app.dependency_overrides[get_session] = database
    app.include_router(capabilities.router)
    app.include_router(capabilities.admin_router)
    app.include_router(tasks.router)
    tokens = {}
    async with sessions() as session:
        session.add(models.OrgUnit(id="skill-fixture-org", name="Skill regression organization"))
        for who in ("alice", "bob", "admin"):
            user = models.User(id=who, username=who, display_name=who, is_super=who == "admin", org_id="skill-fixture-org")
            session.add(user)
            if who != "admin":
                session.add(models.Client(id="device-" + who, name=who, user_ref=who,
                                          auth_state="active", skills=[]))
        await session.commit()
        for who in ("alice", "bob"):
            client = await session.get(models.Client, "device-" + who)
            tokens[who] = device_auth.issue_session(client)[0]
        tokens["admin"] = sign_token("admin")
        tokens["ordinaryUser"] = sign_token("alice")
    empty = root / "empty"
    empty.mkdir()
    patches = [patch.object(skill_packages, "_data_root", lambda: str(root)),
               patch.object(skills, "default_roots", lambda: []),
               patch.object(skills, "bundled_root", lambda: str(empty))]
    for mocked in patches:
        mocked.start()
    skills.clear_scan_cache()
    async def cleanup():
        for mocked in reversed(patches):
            mocked.stop()
        skills.clear_scan_cache()
        await engine.dispose()
    return app, tokens, sessions, cleanup
