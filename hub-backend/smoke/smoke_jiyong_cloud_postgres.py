"""Self-owned, loopback-only PostgreSQL integration. Never accepts a live DB URL."""
import asyncio
import copy
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time


def main():
    binary = os.environ.get('JIYONG_TEST_POSTGRES_BIN')
    if not binary:
        located = shutil.which('initdb')
        if located:
            binary = str(Path(located).parent)
        elif os.name == 'nt':
            binary = r'C:\Program Files\PostgreSQL\18\bin'
    suffix = '.exe' if os.name == 'nt' else ''
    if not binary or not (Path(binary) / ('initdb' + suffix)).is_file():
        raise RuntimeError('PostgreSQL binaries required; set JIYONG_TEST_POSTGRES_BIN to run this isolated integration')
    binary = Path(binary)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    root = Path(tempfile.mkdtemp(prefix='soduwork-jiyong-pg-')).resolve()
    data = root / 'postgres'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    process = None
    try:
        if os.name == 'nt':
            # Python's private temp ACL uses OWNER RIGHTS. PostgreSQL drops
            # elevated privileges, so also grant the invoking user's SID.
            identity = subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'],
                                               creationflags=flags, timeout=10)
            matched = re.search(rb'S-\d+(?:-\d+)+', identity)
            if matched is None:
                raise RuntimeError('Could not determine the Windows user SID for the isolated PostgreSQL directory')
            sid = matched.group().decode('ascii')
            subprocess.run(['icacls', str(root), '/grant:r', f'*{sid}:(OI)(CI)F'],
                           check=True, capture_output=True, creationflags=flags, timeout=10)
        result = subprocess.run([str(binary / ('initdb' + suffix)), '-D', str(data), '-U', 'jiyong_test',
                                 '--auth=trust', '--encoding=UTF8', '--no-locale'], capture_output=True,
                                timeout=60, creationflags=flags)
        if result.returncode:
            raise RuntimeError('temporary initdb failed: ' + result.stderr.decode(errors='replace'))
        # pg_ctl uses PostgreSQL's restricted Windows token when the invoking
        # developer shell is elevated; direct postgres correctly refuses it.
        # Do not use PIPE: a Windows server descendant can retain its handle
        # after pg_ctl exits, keeping communicate() blocked indefinitely.
        with (root / 'control.log').open('wb') as control:
            started = subprocess.run([str(binary / ('pg_ctl' + suffix)), '-D', str(data), 'start',
                                      '-l', str(root / 'postgres.log'), '-o', f'-p {port} -h 127.0.0.1 -c max_connections=30',
                                      '-w', '-t', '15'], stdout=control, stderr=control, timeout=25, creationflags=flags)
        if started.returncode:
            raise RuntimeError('temporary PostgreSQL start failed: ' + (root / 'control.log').read_text(errors='replace'))
        process = True
        print('Temporary PostgreSQL ready', flush=True)
        if process:
            os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///' + (root / '.smoke-hub.db').as_posix()
            os.environ['JIYONG_DATABASE_URL'] = f'postgresql+asyncpg://jiyong_test@127.0.0.1:{port}/smoke-jiyong'
            os.environ['JIYONG_ASSET_DIR'] = str(root / 'assets')
            os.environ['AUTH_SECRET'] = 'isolated-integration-secret-' + 'a' * 40
            os.environ['ADMIN_PASS'] = 'isolated-test-only-password'
            asyncio.run(prepare(port, root))
            print('Applying independent Alembic migration', flush=True)
            result = subprocess.run([sys.executable, '-m', 'alembic', '-c', 'jiyong-alembic.ini', 'upgrade', 'head'],
                                    capture_output=True, timeout=30, creationflags=flags)
            if result.returncode:
                raise RuntimeError('isolated cloud migration failed: ' + result.stderr.decode(errors='replace'))
            print('Verifying cloud data behavior', flush=True)
            asyncio.run(verify(root))
            if '--native' in sys.argv:
                run_native(root, flags)
            print('Verifying independent database and asset backup restore', flush=True)
            asyncio.run(backup_restore(binary, suffix, port, root, flags))
        print(json.dumps({'ok': True, 'checks': ['independent Alembic migration', 'read-only readiness',
            'concurrent automatic provision', 'CAS and rollback', 'tombstones', 'append-only migration',
            'account and app isolation', 'cross-connection persistence', 'quota rollback', 'asset hash and readback',
            'pg_dump/pg_restore with asset readback'],
            'boundary': 'Real temporary PostgreSQL; no production DB, deployment, business account or model.'}))
    finally:
        if process:
            with (root / 'control.log').open('ab') as control:
                subprocess.run([str(binary / ('pg_ctl' + suffix)), '-D', str(data), 'stop', '-m', 'immediate', '-w'],
                               stdout=control, stderr=control, timeout=30, creationflags=flags)
        if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('soduwork-jiyong-pg-'):
            raise RuntimeError('temporary PostgreSQL cleanup path escaped intended directory')
        shutil.rmtree(root)


def run_native(root, flags):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    accounts = root / 'native-accounts.json'
    with (root / 'native-http.log').open('wb') as log:
        server = subprocess.Popen([sys.executable, 'jiyong_cloud_e2e_fixture.py', str(root), str(port)],
                                  stdout=log, stderr=log, creationflags=flags)
        try:
            for _ in range(600):
                if accounts.exists():
                    break
                if server.poll() is not None:
                    raise RuntimeError('isolated auth HTTP fixture failed: ' + (root / 'native-http.log').read_text(errors='replace')[-2500:])
                time.sleep(.1)
            if not accounts.exists():
                raise RuntimeError('isolated auth HTTP fixture did not become ready')
            print('Verifying real native page/HTTP/auth/PostgreSQL loop across fresh device profiles', flush=True)
            node = shutil.which('node')
            evidence = Path('../.local/jiyong-cloud-evidence')
            evidence.mkdir(parents=True, exist_ok=True)
            with (evidence / 'native-client.log').open('wb') as client_log:
                result = subprocess.run([node, '../client/e2e/jiyong-cloud-loop.cjs', str(accounts)], timeout=300,
                                        stdout=client_log, stderr=client_log, creationflags=flags)
            if result.returncode:
                raise RuntimeError('native cloud loop failed: ' + (evidence / 'native-client.log').read_text(errors='replace')[-4000:])
            for phase in ['write', 'second-device', 'other-account', 'reopen-upgraded']:
                shutil.copyfile(root / (phase + '.json'), evidence / ('loop-' + phase + '.json'))
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait(timeout=5)


async def prepare(port, root):
    import asyncpg
    connection = None
    for _ in range(30):
        try:
            connection = await asyncpg.connect(host='127.0.0.1', port=port, user='jiyong_test', database='postgres', timeout=2)
            break
        except (OSError, asyncpg.PostgresError):
            await asyncio.sleep(.1)
    if connection is None:
        raise RuntimeError('temporary PostgreSQL did not become ready')
    try:
        await connection.execute('CREATE DATABASE "smoke-jiyong"')
    finally:
        await connection.close()


async def verify(root):
    from sqlalchemy import text
    from app.services import jiyong_cloud_database as database, jiyong_cloud_storage as storage
    from app.services import jiyong_contract, jiyong_data_contract
    from test_jiyong_cloud_data import declaration, seed
    schema, initial = jiyong_contract.normalize(declaration()), seed()

    async def call(method, params=None, owner='org:user-a', app='local:cloud-notes', version='0.1.0', init=None, checksum='a' * 64):
        return await storage.execute(owner, app, app.split(':')[-1], schema, init or initial, version, checksum,
                                     method, jiyong_data_contract.request(method, params or {}, schema))

    try:
        await database.check()
        async with database.engine().connect() as connection:
            assert await connection.scalar(text('SELECT count(*) FROM jiyong_spaces')) == 0
        assert not (root / 'assets').exists(), 'readiness must not create files'
        # Exercise the actual endpoint and transport validators over ASGI,
        # keeping device/account authentication explicitly fixture-owned.
        import httpx
        from fastapi import FastAPI
        from types import SimpleNamespace
        from app.api import jiyong_data as api
        from test_jiyong_cloud_data import body
        from unittest.mock import AsyncMock
        http_app = FastAPI(); http_app.include_router(api.router)
        user = SimpleNamespace(id='http-user', org_id='http-org', is_active=True, account_deleted_at=None)
        http_app.dependency_overrides[api.current_client] = lambda: SimpleNamespace(id='http-device', user_ref='http-user')
        http_app.dependency_overrides[api.get_session] = lambda: SimpleNamespace(get=AsyncMock(side_effect=lambda model, value:
            user if model is api.User else SimpleNamespace(id=value, parent_id=None)))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=http_app), base_url='http://fixture') as http:
            request = body(); request.update(method='initialize', params={})
            response = await http.post('/api/v1/jiyong/data', json=request)
            assert response.status_code == 200, response.text
            assert response.json()['databaseName'] == 'cloud-notes'
            request.update(method='data.get', params={'collection': 'notes', 'id': 'welcome'})
            response = await http.post('/api/v1/jiyong/data', json=request)
            assert response.status_code == 200 and response.json()['item']['value']['title'] == '欢迎'
        results = await asyncio.gather(*[call('initialize') for _ in range(8)])
        assert all(row['state'] == 'ready' and row['databaseName'] == 'cloud-notes' for row in results)
        assert len((await call('data.list', {'collection': 'notes'}))['items']) == 1
        saved = await call('data.batch', {'collection': 'notes', 'operations': [
            {'id': 'welcome', 'expectedRevision': 1, 'value': {'status': 'open', 'title': 'user content'}}]})
        assert saved['items'][0]['revision'] == 2
        conflict = {'collection': 'notes', 'operations': [
            {'id': 'temporary', 'expectedRevision': 0, 'value': {'status': 'open'}},
            {'id': 'welcome', 'expectedRevision': 1, 'delete': True}]}
        try:
            await call('data.batch', conflict)
            raise AssertionError('conflict did not roll back')
        except database.CloudError as exc:
            assert exc.code == 'JIYONG_CONFLICT'
        assert (await call('data.get', {'collection': 'notes', 'id': 'temporary'}))['item'] is None
        competing = await asyncio.gather(*[call('data.batch', {'collection': 'notes', 'operations': [
            {'id': 'race', 'expectedRevision': 0, 'value': {'status': 'open'}}]}) for _ in range(2)], return_exceptions=True)
        assert sum(isinstance(x, database.CloudError) and x.code == 'JIYONG_CONFLICT' for x in competing) == 1
        page = await call('data.list', {'collection': 'notes', 'limit': 1, 'filter': {'status': 'open'}})
        assert page['next'] and len(page['items']) == 1
        page2 = await call('data.list', {'collection': 'notes', 'limit': 1, 'after': page['next'], 'filter': {'status': 'open'}})
        assert len(page2['items']) == 1 and page2['next'] is None
        await call('data.batch', {'collection': 'notes', 'operations': [{'id': 'race', 'expectedRevision': 1, 'delete': True}]})
        tombstone = await call('data.get', {'collection': 'notes', 'id': 'race'})
        assert tombstone['item'] is None and tombstone['revision'] == 2
        await call('initialize')
        assert (await call('data.get', {'collection': 'notes', 'id': 'welcome'}))['item']['value']['title'] == 'user content'
        next_init = copy.deepcopy(initial)
        next_init['migrations'].append({'version': 2, 'seed': [{'collection': 'notes', 'id': 'next', 'value': {'status': 'example'}}]})
        assert (await call('initialize', version='0.2.0', init=next_init, checksum='b' * 64))['migrationVersion'] == 2
        modified = copy.deepcopy(next_init); modified['migrations'][0]['seed'][0]['value']['title'] = 'changed history'
        try:
            await call('initialize', version='0.3.0', init=modified, checksum='c' * 64)
            raise AssertionError('edited migration was accepted')
        except database.CloudError as exc:
            assert exc.code == 'JIYONG_MIGRATION_CONFLICT'
        try:
            await call('initialize')
            raise AssertionError('older migration replaced newer cloud data')
        except database.CloudError as exc:
            assert exc.code == 'JIYONG_VERSION_CONFLICT'
        assert (await call('data.get', {'collection': 'notes', 'id': 'next'}, owner='org:user-b'))['item'] is None
        assert (await call('data.get', {'collection': 'notes', 'id': 'next'}, app='local:another'))['item'] is None
        await database.close()
        assert (await call('data.get', {'collection': 'notes', 'id': 'next'}, version='0.2.0', init=next_init, checksum='b' * 64))['item']
        asset = await call('data.assetPut', {'name': '图标.svg', 'type': 'image/svg+xml', 'data': 'PHN2Zy8+'},
                           version='0.2.0', init=next_init, checksum='b' * 64)
        read = await call('data.assetGet', {'id': asset['asset']['id']}, version='0.2.0', init=next_init, checksum='b' * 64)
        assert read['data'] == 'PHN2Zy8+'
        assert (await call('data.assetPut', {'name': '图标.svg', 'type': 'image/svg+xml', 'data': 'PHN2Zy8+'},
                           version='0.2.0', init=next_init, checksum='b' * 64))['asset']['id'] == asset['asset']['id']
        settings = database.get_settings()
        old_limit = settings.jiyong_max_records_per_space
        settings.jiyong_max_records_per_space = 1
        try:
            try:
                await call('initialize', owner='quota:test', init=next_init)
                raise AssertionError('seed quota exceeded without rollback')
            except database.CloudError as exc:
                assert exc.code == 'JIYONG_QUOTA'
            async with database.engine().connect() as connection:
                assert await connection.scalar(text("SELECT count(*) FROM jiyong_spaces WHERE owner_id='quota:test'")) == 0
        finally:
            settings.jiyong_max_records_per_space = old_limit
    finally:
        await database.close()


async def backup_restore(binary, suffix, port, root, flags):
    import asyncpg
    from app.services import jiyong_cloud_database as database, jiyong_cloud_storage as storage, jiyong_contract
    from test_jiyong_cloud_data import declaration, seed
    dump = root / 'app-data.backup'
    args = ['-h', '127.0.0.1', '-p', str(port), '-U', 'jiyong_test']
    subprocess.run([str(binary / ('pg_dump' + suffix)), *args, '-F', 'c', '-f', str(dump), 'smoke-jiyong'],
                   capture_output=True, timeout=30, check=True, creationflags=flags)
    shutil.copytree(root / 'assets', root / 'restored-assets')
    connection = await asyncpg.connect(host='127.0.0.1', port=port, user='jiyong_test', database='postgres')
    try:
        await connection.execute('CREATE DATABASE "smoke-jiyong-restored"')
    finally:
        await connection.close()
    subprocess.run([str(binary / ('pg_restore' + suffix)), *args, '-d', 'smoke-jiyong-restored', str(dump)],
                   capture_output=True, timeout=30, check=True, creationflags=flags)
    settings = database.get_settings()
    settings.jiyong_database_url = settings.jiyong_database_url.rsplit('/', 1)[0] + '/smoke-jiyong-restored'
    settings.jiyong_asset_dir = str(root / 'restored-assets')
    initial = seed()
    initial['migrations'].append({'version': 2, 'seed': [{'collection': 'notes', 'id': 'next', 'value': {'status': 'example'}}]})
    schema = jiyong_contract.normalize(declaration())
    try:
        await database.check()
        row = await storage.execute('org:user-a', 'local:cloud-notes', 'cloud-notes', schema, initial, '0.2.0', 'b' * 64,
                                    'data.get', {'collection': 'notes', 'id': 'welcome'})
        assert row['item']['value']['title'] == 'user content'
        asset = await storage.execute('org:user-a', 'local:cloud-notes', 'cloud-notes', schema, initial, '0.2.0', 'b' * 64,
                                      'data.assetGet', {'id': storage.asset_id('图标.svg', 'image/svg+xml', b'<svg/>')})
        assert asset['data'] == 'PHN2Zy8+'
    finally:
        await database.close()


if __name__ == '__main__':
    main()
