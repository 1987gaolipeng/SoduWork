"""Authenticated cloud app storage; account and namespace never come from a page."""
import asyncio
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client
from ..models import Client, User, OrgUnit
from ..services import jiyong_cloud_database as database, jiyong_cloud_storage as storage
from ..services import jiyong_contract as contract, jiyong_data_contract as data_contract

router = APIRouter(prefix='/api/v1/jiyong', tags=['jiyong-data'])


async def owner(session, client):
    user = await session.get(User, str(client.user_ref or ''))
    if not user or not user.is_active or user.account_deleted_at:
        raise HTTPException(403, '请先登录有效的 SoduWork 账号')
    # Departments are mutable. Bind to the company root so an internal transfer
    # does not strand the same user's data; moving company is a new boundary.
    current, seen = str(user.org_id or ''), set()
    company = 'personal'
    while current:
        if current in seen or len(seen) >= 64:
            raise HTTPException(403, '组织归属无法验证，请联系管理员')
        seen.add(current)
        organization = await session.get(OrgUnit, current)
        if organization is None:
            raise HTTPException(403, '组织归属无法验证，请联系管理员')
        company = current
        current = str(organization.parent_id or '')
    return user, company + ':' + user.id


async def accepted(session, client, user, body):
    contract.only(body, ['appId', 'packageKey', 'version', 'versionId', 'checksum',
                         'declaration', 'initialization', 'method', 'params'])
    app_id = body.get('appId')
    if not isinstance(app_id, str) or not re.fullmatch(r'(?:local:)?[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}', app_id):
        raise ValueError('目标即用标识无效')
    if app_id.startswith('local:'):
        key = body.get('packageKey')
        if not isinstance(key, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', key):
            raise ValueError('云端数据需要合法的稳定包名')
        version, checksum = body.get('version'), body.get('checksum')
        if (not isinstance(version, str) or len(version) > 120
                or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version)
                or not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum)):
            raise ValueError('云端数据需要不可变包版本和 SHA-256 摘要')
        declaration = contract.normalize(body.get('declaration'))
        initialization = data_contract.initialization(declaration, body.get('initialization'))
        # Personal namespaces are owner-private; local declarations cannot grant
        # access to an enterprise package namespace or another account.
        # A local installation UUID differs on every device. The signed-in
        # owner's package key is the portable personal namespace; it never
        # overlaps a market application's independently authorized namespace.
        package = 'personal:' + key
    else:
        from .plugin_client_catalog import _client_actor
        from ..services import plugin_package_resources, jiyong_initialization, plugin_installed
        actor = await _client_actor(session, client)
        try:
            selected = await plugin_installed.resolve(session, actor.org_id, actor.user_id, [app_id], provision_defaults=False)
            pinned = selected[0][1]
        except (ValueError, IndexError) as exc:
            raise HTTPException(403, str(exc)) from exc
        if body.get('versionId') != pinned.id:
            raise HTTPException(409, '即用安装版本已变化，请重新打开')
        if str(pinned.plugin_id) != app_id:
            raise HTTPException(403, '无法验证即用安装版本')
        declaration = contract.normalize(dict(pinned.manifest or {}).get('jiyong'))
        bundle = await asyncio.to_thread(plugin_package_resources.ui_for_version, pinned)
        initialization = jiyong_initialization.parse(declaration, bundle['resources'])
        key = str(pinned.manifest['key'])
        package, version, checksum = 'market:' + app_id, pinned.version, pinned.checksum
    if declaration.get('storage', {}).get('location') != 'cloud':
        raise ValueError('即用未声明云端数据，不能自动上传本地数据')
    params = data_contract.request(body.get('method'), body.get('params', {}), declaration)
    return package, key, declaration, initialization, version, checksum, params


@router.get('/status')
async def status(client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    await owner(session, client)
    try:
        return await database.check()
    except database.CloudError as exc:
        raise HTTPException(exc.status, {'code': exc.code, 'message': str(exc)}) from exc


@router.post('/data')
async def data(request: Request, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    user, scope = await owner(session, client)
    parts, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 16 * 1024 * 1024:
            raise HTTPException(413, '即用数据请求过大')
        parts.append(chunk)
    try:
        body = json.loads(b''.join(parts))
        package, key, declaration, initialization, version, checksum, params = await accepted(session, client, user, body)
        return await storage.execute(scope, package, key, declaration, initialization, version, checksum, body['method'], params)
    except database.CloudError as exc:
        raise HTTPException(exc.status, {'code': exc.code, 'message': str(exc)}) from exc
    except (ValueError, TypeError, KeyError, RecursionError) as exc:
        raise HTTPException(422, {'code': 'JIYONG_INVALID_REQUEST', 'message': str(exc)[:300]}) from exc
