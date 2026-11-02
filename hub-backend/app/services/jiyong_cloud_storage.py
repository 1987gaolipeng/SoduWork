"""Account-owned app schemas, atomic initialization and CAS business records.

Identifiers derive only from trusted identity hashes. Package SQL and executable
install hooks are never accepted. The independent platform DB uses Alembic;
per-app tables below are resource provisioning, not Hub startup schema repair.
"""
import asyncio
import base64
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from ..config import get_settings
from . import jiyong_cloud_database as database


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def identity(owner, package):
    digest = hashlib.sha256((owner + '\0' + package).encode()).hexdigest()
    return digest, 'jiyong_' + digest[:40]


async def lock(connection, name):
    number = int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], 'big', signed=True)
    await connection.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': number})


async def provision(connection, owner, package, name, declaration, initialization, version, checksum):
    space, schema = identity(owner, package)
    await lock(connection, space)
    row = await connection.scalar(text('SELECT id FROM jiyong_spaces WHERE id=:id'), {'id': space})
    if row is None:
        # Serialize the per-owner space quota even across different app schemas.
        await lock(connection, 'owner:' + owner)
        count = await connection.scalar(text('SELECT count(*) FROM jiyong_spaces WHERE owner_id=:owner'), {'owner': owner})
        if count >= get_settings().jiyong_max_spaces_per_user:
            raise database.CloudError('云端即用数据空间数量已达上限', 'JIYONG_QUOTA', 409)
        await connection.execute(text('INSERT INTO jiyong_spaces VALUES (:id,:owner,:package,:name,:at)'),
                                 dict(id=space, owner=owner, package=package, name=name, at=datetime.now(timezone.utc)))
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        await connection.execute(text(f'CREATE TABLE "{schema}".records ('
            'collection varchar(64) NOT NULL,id varchar(64) COLLATE "C" NOT NULL,value jsonb,'
            'revision bigint NOT NULL, "updatedAt" varchar(40) NOT NULL,PRIMARY KEY(collection,id))'))
        await connection.execute(text(f'CREATE TABLE "{schema}".migrations ('
            'version integer PRIMARY KEY, checksum varchar(64) NOT NULL)'))
        await connection.execute(text(f'CREATE TABLE "{schema}".versions ('
            'version varchar(120) PRIMARY KEY, checksum varchar(64) NOT NULL, digest varchar(64) NOT NULL)'))
        await connection.execute(text(f'CREATE TABLE "{schema}".assets ('
            'id varchar(70) PRIMARY KEY,name varchar(160) NOT NULL,type varchar(160) NOT NULL,size bigint NOT NULL)'))
    digest = hashlib.sha256(canonical({'declaration': declaration, 'initialization': initialization}).encode()).hexdigest()
    previous = (await connection.execute(text(f'SELECT checksum,digest FROM "{schema}".versions WHERE version=:version'),
                                          {'version': version})).mappings().first()
    if previous and (previous['checksum'] != checksum or previous['digest'] != digest):
        raise database.CloudError('相同应用版本的声明或资源发生变化，请提升版本', 'JIYONG_VERSION_CONFLICT', 409)
    applied = dict((await connection.execute(text(f'SELECT version,checksum FROM "{schema}".migrations'))).all())
    if applied and max(applied) > len(initialization['migrations']):
        raise database.CloudError('云端数据来自更新版本，请升级应用', 'JIYONG_VERSION_CONFLICT', 409)
    for step in initialization['migrations']:
        checksum_step = hashlib.sha256(canonical(step).encode()).hexdigest()
        if step['version'] in applied:
            if applied[step['version']] != checksum_step:
                raise database.CloudError('已执行的初始化脚本被修改，请追加迁移版本', 'JIYONG_MIGRATION_CONFLICT', 409)
            continue
        for seed in step['seed']:
            await connection.execute(text(f'INSERT INTO "{schema}".records VALUES (:collection,:id,CAST(:value AS jsonb),1,:at) '
                                           'ON CONFLICT(collection,id) DO NOTHING'),
                                     dict(collection=seed['collection'], id=seed['id'], value=canonical(seed['value']), at=now()))
        await connection.execute(text(f'INSERT INTO "{schema}".migrations VALUES (:version,:checksum)'),
                                 {'version': step['version'], 'checksum': checksum_step})
    # Safe, bounded names and fields are validated by jiyong_contract first.
    count = await connection.scalar(text(f'SELECT count(*) FROM "{schema}".records'))
    if count > get_settings().jiyong_max_records_per_space:
        raise database.CloudError('云端记录数量已达上限', 'JIYONG_QUOTA', 409)
    for collection in declaration['collections'] if not previous else []:
        for field in collection['indexes']:
            index = 'idx_' + hashlib.sha256((collection['key'] + ':' + field).encode()).hexdigest()[:32]
            await connection.execute(text(f'CREATE INDEX IF NOT EXISTS "{index}" ON "{schema}".records '
                                           f"(collection,(value -> '{field}'),id)"))
    if not previous:
        await connection.execute(text(f'INSERT INTO "{schema}".versions VALUES (:version,:checksum,:digest)'),
                                 dict(version=version, checksum=checksum, digest=digest))
    return space, schema


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def record(row):
    if row is None:
        return None
    result = dict(row)
    if isinstance(result['value'], str):
        result['value'] = json.loads(result['value'])
    return result


async def read(connection, schema, collection, row_id):
    return record((await connection.execute(text(f'SELECT id,value,revision,"updatedAt" FROM "{schema}".records '
                                                   'WHERE collection=:collection AND id=:id'),
                                            {'collection': collection, 'id': row_id})).mappings().first())


async def records(connection, schema, method, params):
    if method == 'data.get':
        row = await read(connection, schema, params['collection'], params['id'])
        return {'ok': True, 'item': row if row and row['value'] is not None else None, 'revision': row['revision'] if row else 0}
    if method == 'data.list':
        values = dict(collection=params['collection'], after=params['after'], limit=params['limit'] + 1)
        filters = []
        for i, (field, value) in enumerate(params['filter'].items()):
            expression = f"value -> '{field}'"
            if value is None:
                expression = f"COALESCE({expression},'null'::jsonb)"
            filters.append(f"({expression})=CAST(:filter{i} AS jsonb)")
            values['filter' + str(i)] = canonical(value)
        query = f'SELECT id,value,revision,"updatedAt" FROM "{schema}".records WHERE collection=:collection AND id>:after AND value IS NOT NULL'
        if filters:
            query += ' AND ' + ' AND '.join(filters)
        rows = (await connection.execute(text(query + ' ORDER BY id LIMIT :limit'), values)).mappings().all()
        items, size, more = [], 0, False
        for row in rows:
            item = record(row)
            length = len(canonical(item['value']).encode())
            if len(items) >= params['limit'] or (items and size + length > 1024 * 1024):
                more = True
                break
            items.append(item)
            size += length
        return {'ok': True, 'items': items, 'next': items[-1]['id'] if more else None}
    count = await connection.scalar(text(f'SELECT count(*) FROM "{schema}".records'))
    items = []
    for op in params['operations']:
        current = await read(connection, schema, params['collection'], op['id'])
        if (current['revision'] if current else 0) != op['expectedRevision']:
            raise database.CloudError('数据已更新，请重新读取后合并', 'JIYONG_CONFLICT', 409)
        if not current:
            count += 1
            if count > get_settings().jiyong_max_records_per_space:
                raise database.CloudError('云端记录数量已达上限', 'JIYONG_QUOTA', 409)
        revision, at = op['expectedRevision'] + 1, now()
        value = None if op.get('delete') else canonical(op['value'])
        await connection.execute(text(f'INSERT INTO "{schema}".records VALUES (:collection,:id,CAST(:value AS jsonb),:revision,:at) '
            'ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,revision=excluded.revision,"updatedAt"=excluded."updatedAt"'),
            dict(collection=params['collection'], id=op['id'], value=value, revision=revision, at=at))
        items.append({'id': op['id'], 'deleted': True, 'revision': revision} if op.get('delete') else
                     {'id': op['id'], 'value': op['value'], 'revision': revision, 'updatedAt': at})
    return {'ok': True, 'items': items}


def asset_id(name, kind, data):
    return 'asset_' + hashlib.sha256((name + '\0' + kind + '\0').encode() + data).hexdigest()


def write_asset(file, data):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if file.exists():
        if file.read_bytes() != data:
            raise database.CloudError('素材存储校验失败', 'JIYONG_ASSET_CORRUPT', 500)
        return
    temporary = file.with_name(file.name + '.next-' + uuid4().hex)
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


async def assets(connection, space, schema, method, params):
    root = Path(get_settings().jiyong_asset_dir) / space
    if method == 'data.assetPut':
        data = params['data']
        row_id = asset_id(params['name'], params['type'], data)
        previous = await connection.scalar(text(f'SELECT id FROM "{schema}".assets WHERE id=:id'), {'id': row_id})
        if not previous:
            size = await connection.scalar(text(f'SELECT COALESCE(sum(size),0) FROM "{schema}".assets'))
            if size + len(data) > get_settings().jiyong_max_asset_bytes_per_space:
                raise database.CloudError('云端素材空间已达上限', 'JIYONG_QUOTA', 409)
        await asyncio.to_thread(write_asset, root / row_id, data)
        metadata = {'id': row_id, 'name': params['name'], 'type': params['type'], 'size': len(data)}
        await connection.execute(text(f'INSERT INTO "{schema}".assets VALUES (:id,:name,:type,:size) ON CONFLICT(id) DO NOTHING'), metadata)
        return {'ok': True, 'asset': metadata}
    metadata = (await connection.execute(text(f'SELECT id,name,type,size FROM "{schema}".assets WHERE id=:id'), params)).mappings().first()
    if metadata is None:
        return {'ok': True, 'asset': None}
    file = root / params['id']
    try:
        stat = await asyncio.to_thread(file.stat)
        if stat.st_size != metadata['size'] or metadata['size'] > 8 * 1024 * 1024:
            raise OSError('invalid size')
        data = await asyncio.to_thread(file.read_bytes)
        if asset_id(metadata['name'], metadata['type'], data) != metadata['id']:
            raise OSError('invalid digest')
    except OSError as exc:
        raise database.CloudError('云端素材缺失或校验失败', 'JIYONG_ASSET_CORRUPT', 500) from exc
    return {'ok': True, 'asset': dict(metadata), 'data': base64.b64encode(data).decode('ascii')}


async def execute(owner, package, name, declaration, initialization, version, checksum, method, params):
    try:
        return await _execute(owner, package, name, declaration, initialization, version, checksum, method, params)
    except (SQLAlchemyError, OSError, TimeoutError) as exc:
        # Do not expose SQL parameters, filesystem paths or business record
        # contents through the global exception logger or the app response.
        raise database.CloudError('云端数据操作未完成，请重新读取核对；持续失败请检查数据库与素材存储') from exc


async def _execute(owner, package, name, declaration, initialization, version, checksum, method, params):
    await database.check()
    async with database.engine().begin() as connection:
        await connection.execute(text("SET LOCAL lock_timeout='5s'"))
        await connection.execute(text("SET LOCAL statement_timeout='15s'"))
        space, schema = await provision(connection, owner, package, name, declaration, initialization, version, checksum)
        if method == 'initialize':
            return {'ok': True, 'state': 'ready', 'location': 'cloud', 'databaseName': name,
                    'databaseVersion': 1, 'migrationVersion': len(initialization['migrations'])}
        if method.startswith('data.asset'):
            return await assets(connection, space, schema, method, params)
        return await records(connection, schema, method, params)
