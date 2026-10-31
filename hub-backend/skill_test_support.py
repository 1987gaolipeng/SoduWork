"""Isolated real-auth fixture shared by API and browser Skill regression tests."""
import atexit
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ["CLUSTER_REDIS_URL"] = ""
from pathlib import Path
import shutil
import tempfile
import threading
from unittest.mock import patch
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.db import Base, get_session
from app import models, automation_models, project_context_models
from app.api import capabilities, tasks
from app.auth import sign_token
from app.services import device_auth, skill_packages, skills


_schema_lock = threading.Lock()
_schema_root = None
_schema_path = None
_schema_pid = None


def _pristine_schema():
    """Build one data-free SQLite schema per process for cheap isolated copies."""
    global _schema_root, _schema_path, _schema_pid
    pid = os.getpid()
    with _schema_lock:
        if _schema_path is not None and _schema_pid == pid:
            return _schema_path
        root = Path(tempfile.mkdtemp(prefix="soduwork-test-schema-"))
        path = root / "schema.db"
        try:
            engine = create_engine("sqlite:///" + path.as_posix())
            try:
                Base.metadata.create_all(engine)
            finally:
                engine.dispose()
        except BaseException:
            shutil.rmtree(root, ignore_errors=True)
            raise
        # Publish only after all DDL and connection cleanup completed. The
        # template remains immutable; each fixture writes to its own copy.
        _schema_root = root
        _schema_path = path
        _schema_pid = pid
        return path


def _cleanup_schema():
    global _schema_root, _schema_path, _schema_pid
    with _schema_lock:
        root = _schema_root if _schema_pid == os.getpid() else None
        _schema_root = None
        _schema_path = None
        _schema_pid = None
    if root is not None:
        shutil.rmtree(root, ignore_errors=True)


def _reset_schema_after_fork():
    """A forked child must neither reuse nor delete its parent's template."""
    global _schema_lock, _schema_root, _schema_path, _schema_pid
    _schema_lock = threading.Lock()
    _schema_root = None
    _schema_path = None
    _schema_pid = None


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_schema_after_fork)


atexit.register(_cleanup_schema)


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
