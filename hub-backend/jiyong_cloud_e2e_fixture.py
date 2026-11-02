"""Loopback fixture with the real device-session auth and cloud data router.

Started only by smoke_jiyong_cloud_postgres --native. All databases, signing
keys, users and devices are created in that script's temporary directory.
"""
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
import sys

from fastapi import FastAPI
import uvicorn

from app.api.jiyong_data import router
from app.db import SessionLocal, engine, init_db
from app.models import Client, OrgUnit, User
from app.services import device_auth, jiyong_cloud_database

directory = Path(sys.argv[1]).resolve()
port = int(sys.argv[2])
if not directory.name.startswith('soduwork-jiyong-pg-') or 'smoke' not in os.environ.get('DATABASE_URL', ''):
    raise RuntimeError('fixture must use the owning temporary smoke directory')


@asynccontextmanager
async def lifespan(app):
    await init_db()
    async with SessionLocal() as session:
        organization = OrgUnit(id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name='Isolated cloud test')
        users = [User(id=f'{str(n)*8}-{str(n)*4}-4{str(n)*3}-8{str(n)*3}-{str(n)*12}',
                      username='cloud-e2e-' + str(n), display_name='Fixture ' + str(n), org_id=organization.id)
                 for n in [1, 2]]
        session.add_all([organization, *users])
        await session.flush()
        devices = []
        for key, user in [('a1', users[0]), ('a2', users[0]), ('other', users[1])]:
            device = Client(id='u-jiyong-cloud-' + key, name='Isolated ' + key)
            device_auth.activate(device, user)
            session.add(device)
            devices.append((key, device, user))
        await session.commit()
        accounts = {key: {'hub': f'http://127.0.0.1:{port}', 'clientId': device.id,
                          'session': device_auth.issue_session(device)[0], 'userId': user.id}
                    for key, device, user in devices}
        (directory / 'native-accounts.json').write_text(json.dumps(accounts), encoding='utf-8')
        os.chmod(directory / 'native-accounts.json', 0o600)
    try:
        yield
    finally:
        await jiyong_cloud_database.close()
        await engine.dispose()


app = FastAPI(lifespan=lifespan)
app.include_router(router)


@app.get('/fixture/health')
async def health():
    return {'ok': True}


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='error', access_log=False)
