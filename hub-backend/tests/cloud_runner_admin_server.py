"""Disposable loopback fixture: migrated DB and real admin/device HTTP routes."""
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# This fixture sets an isolated database before importing app configuration.
from test_cloud_runner_admin import CloudRunnerAdminTests
from app import db, models
from app.api import admin
from app.auth import hash_password
import uvicorn


async def serve():
    fixture = CloudRunnerAdminTests()
    await fixture.asyncSetUp()
    fixture.app.include_router(admin.router)
    async with db.SessionLocal() as s:
        manager = await s.get(models.User, fixture.manager_id)
        manager.password_hash = hash_password('fixture-password-only')
        role = await s.get(models.Role, fixture.prefix + '-role')
        role.permissions = ['runner.manage', 'client.view', 'audit.view']
        recipient = await s.get(models.User, fixture.target_id)
        recipient.display_name = 'Cloud recipient'
        await s.commit()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]

    @asynccontextmanager
    async def lifespan(app):
        print(json.dumps({'ready': True, 'fixtureOnly': True, 'url': f'http://127.0.0.1:{port}',
            'username': fixture.manager_id, 'password': 'fixture-password-only',
            'deviceToken': fixture.http.headers['Authorization'], 'originalRunner': fixture.rid,
            'targetUser': fixture.target_id}), flush=True)
        yield

    fixture.app.router.lifespan_context = lifespan

    @fixture.app.get('/healthz')
    async def health():
        return {'ok': True, 'fixtureOnly': True}

    try:
        await uvicorn.Server(uvicorn.Config(fixture.app, log_level='warning')).serve(sockets=[sock])
    finally:
        sock.close()
        await fixture.asyncTearDown()


if __name__ == '__main__':
    asyncio.run(serve())
