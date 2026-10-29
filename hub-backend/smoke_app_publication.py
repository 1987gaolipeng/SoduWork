"""Real app submission/review/catalog HTTP flow against a temporary SQLite DB only."""
import asyncio
from datetime import datetime, timezone
import os
import tempfile
from pathlib import Path

_TEMP = tempfile.TemporaryDirectory(prefix='soduwork-smoke-app-review-')
os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///' + (Path(_TEMP.name) / 'test.db').as_posix()
os.environ['SODUWORK_DATA_ROOT'] = str(Path(_TEMP.name) / 'data')
os.environ['AUTH_SECRET'] = 'isolated-app-publication-fixture-not-a-real-secret'
os.environ['ADMIN_PASS'] = 'isolated-app-fixture-password'

import httpx
from sqlalchemy import select
from app import auth, automation_models as am, models
from app.db import SessionLocal, engine, init_db
from app.main import app
from app.services import device_auth, plugin_drafts, plugin_service

checks = []
def check(name, condition):
    if not condition:
        raise AssertionError(name)
    checks.append(name)

def draft(version='1.0.0', key='reviewed-app'):
    return dict(template='app', key=key, name='Application review fixture', version=version,
                description='Application shares plugin review', instructions='Use this app to inspect supplied facts.',
                ui={'contributions': [{'id': 'main', 'title': 'App', 'slot': 'workspace.navigation',
                    'source': {'type': 'external', 'url': 'https://example.invalid/app', 'openMode': 'workspace'}}]})

async def main():
    await init_db()
    async with SessionLocal() as session:
        session.add_all([models.OrgUnit(id='org-app-review', name='Fixture org'),
                         models.OrgUnit(id='org-app-outside', name='Outside org')])
        session.add_all([
            models.User(id='app-author', username='app-author', display_name='App author', org_id='org-app-review', is_active=True),
            models.User(id='app-reviewer', username='app-reviewer', display_name='App reviewer', org_id='org-app-review', is_active=True, is_super=True),
            models.User(id='app-outsider', username='app-outsider', display_name='Outside', org_id='org-app-outside', is_active=True),
            models.Client(id='app-author-device', name='Author', auth_state='active', user_ref='app-author'),
            models.Client(id='app-outside-device', name='Outside', auth_state='active', user_ref='app-outsider')])
        await session.commit()
        tokens = {cid: device_auth.issue_session(await session.get(models.Client, cid))[0]
                  for cid in ['app-author-device', 'app-outside-device']}
    employee = {'Authorization': 'Device ' + tokens['app-author-device']}
    outsider = {'Authorization': 'Device ' + tokens['app-outside-device']}
    reviewer = {'Authorization': 'Bearer ' + auth.sign_token('app-reviewer', ttl_hours=1)}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        async def catalog(headers=employee):
            response = await client.get('/api/v1/plugins/catalog', headers=headers)
            check('catalog request succeeds', response.status_code == 200)
            return response.json()
        response = await client.post('/api/v1/plugins/personal-publish', headers=employee,
                                     json={'draft': draft(), 'visibility': 'organization'})
        check('app uses existing personal-publish route: ' + str(response.status_code) + ' ' + response.text[:500], response.status_code == 200)
        plugin = response.json()['plugin']; pid = plugin['id']; version = plugin['latestVersion']; vid = version['id']
        check('submitted app retains type and stays quarantined/disabled',
              version['manifest']['template'] == 'app' and version['trustState'] == 'quarantined' and not version['enabled'])
        before = await catalog()
        check('unreviewed app is absent from employee marketplace', not any(row['pluginId'] == pid for row in before['items']))
        check('author submission retains app type while pending', any(row['versionId'] == vid and row.get('template') == 'app' for row in before['submissions']))
        governance = await client.get('/api/v1/admin/plugins/governance', headers=reviewer)
        check('app joins the shared plugin review queue', governance.status_code == 200 and any(
            row['versionId'] == vid for row in governance.json()['queues']['review']))
        denied = await client.post('/api/v1/admin/plugins/versions/' + vid + '/trust', headers=employee, json={'enabled': True})
        check('device user cannot bypass admin review', denied.status_code in (401, 403))
        accepted = await client.post('/api/v1/admin/plugins/versions/' + vid + '/trust', headers=reviewer, json={'enabled': True})
        check('enterprise app uses existing lightweight admin approval', accepted.status_code == 200 and accepted.json()['trustState'] == 'approved')
        published = next(row for row in (await catalog())['items'] if row['pluginId'] == pid)
        check('approved app reaches catalog with its app identity and page', published.get('template') == 'app' and bool(published.get('ui')))
        endpoint = '/api/v1/admin/plugins/' + pid + '/catalog-policy'
        missing = await client.patch(endpoint, headers=reviewer, json={'featured': True})
        check('recommendation requires artwork', missing.status_code == 422)
        unsafe = await client.patch(endpoint, headers=reviewer, json={'featured': True, 'coverUrl': 'javascript:alert(1)'})
        check('active cover URLs are rejected', unsafe.status_code == 422)
        denied = await client.patch(endpoint, headers=employee, json={'featured': True, 'coverUrl': 'https://example.invalid/cover.jpg'})
        check('device cannot recommend a plugin', denied.status_code in (401, 403))
        recommended = await client.patch(endpoint, headers=reviewer, json={'featured': True, 'coverUrl': 'https://example.invalid/cover.jpg'})
        check('admin can recommend through shared policy', recommended.status_code == 200 and recommended.json()['featured'])
        featured = next(row for row in (await catalog())['items'] if row['pluginId'] == pid)
        check('uninstalled recommended app carries cover and install state', featured['marketPolicy']['featured'] and featured['coverUrl'] == 'https://example.invalid/cover.jpg' and not featured['installed'])
        removed = await client.patch(endpoint, headers=reviewer, json={'featured': False})
        check('cancel recommendation preserves visibility and artwork', removed.status_code == 200 and not removed.json()['featured'] and bool(removed.json()['coverUrl']))
        covered_draft = {**draft(key='covered-app'), 'coverUrl': 'https://example.invalid/declared-cover.jpg'}
        declared_response = await client.post('/api/v1/plugins/personal-publish', headers=employee,
            json={'draft': covered_draft, 'visibility': 'organization'})
        declared_plugin = declared_response.json()['plugin']
        await client.post('/api/v1/admin/plugins/versions/' + declared_plugin['latestVersion']['id'] + '/trust', headers=reviewer, json={'enabled': True})
        declared_recommendation = await client.patch('/api/v1/admin/plugins/' + declared_plugin['id'] + '/catalog-policy', headers=reviewer, json={'featured': True})
        check('recommendation accepts artwork declared in the approved manifest', declared_recommendation.status_code == 200 and declared_recommendation.json()['coverUrl'] == covered_draft['coverUrl'])
        check('app remains isolated to its organization', not any(row['pluginId'] == pid for row in (await catalog(outsider))['items']))
        response = await client.post('/api/v1/plugins/personal-publish', headers=employee,
                                     json={'draft': draft('1.1.0'), 'visibility': 'organization'})
        check('new app version returns to quarantine', response.status_code == 200 and response.json()['plugin']['latestVersion']['trustState'] == 'quarantined')
        new_vid = response.json()['plugin']['latestVersion']['id']
        rejected = await client.post('/api/v1/admin/plugins/versions/' + new_vid + '/trust', headers=reviewer,
                                     json={'enabled': False, 'note': 'Clarify app permissions'})
        check('app rejection uses the same review endpoint', rejected.status_code == 200 and rejected.json()['trustState'] == 'revoked')
        # SQLite timestamps have second precision; submission feedback must use
        # the same deterministic ordering as management and governance views.
        async with SessionLocal() as session:
            for version_id in [vid, new_vid]:
                saved = await session.get(am.PluginVersion, version_id)
                saved.created_at = datetime(2026, 10, 21, tzinfo=timezone.utc)
            await session.commit()
        own = await catalog()
        check('author receives rejection feedback with app identity', any(row['versionId'] == new_vid and row.get('template') == 'app'
              and row['reviewDecision'] == 'reject' and row['reviewNote'] == 'Clarify app permissions' for row in own['submissions']))
        check('rejecting new app version preserves approved older version', any(row['versionId'] == vid for row in own['items']))
        revoked = await client.post('/api/v1/admin/plugins/versions/' + vid + '/trust', headers=reviewer, json={'enabled': False, 'note': 'Revoke fixture'})
        check('revoked app is removed from catalog', revoked.status_code == 200 and not any(row['pluginId'] == pid for row in (await catalog())['items']))
        async with SessionLocal() as session:
            admin = await session.get(models.User, 'app-reviewer')
            platform = await plugin_service.install(session, plugin_drafts.build(draft(key='platform-app-review')), admin, None)
            platform_vid = platform['versionId']
        blocked = await client.post('/api/v1/admin/plugins/versions/' + platform_vid + '/trust', headers=reviewer, json={'enabled': True})
        check('platform app cannot bypass the existing evaluation gate', blocked.status_code == 409)
        async with SessionLocal() as session:
            logs = list((await session.execute(select(models.AuditLog).where(models.AuditLog.target_id.in_([vid, new_vid])))).scalars())
            check('app approval/rejection/revocation keep plugin audit records', {'plugin.approve', 'plugin.reject', 'plugin.revoke'} <= {row.action for row in logs})
    print('PASS=' + str(len(checks)) + ' FAIL=0 (isolated SQLite; no live data or models)')

async def guarded():
    try:
        await main()
    finally:
        await engine.dispose()
        _TEMP.cleanup()

if __name__ == '__main__':
    asyncio.run(guarded())
