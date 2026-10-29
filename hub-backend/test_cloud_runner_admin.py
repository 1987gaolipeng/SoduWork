"""Authenticated admin/desktop ownership lifecycle, isolated migrated database."""
import asyncio
import unittest

import httpx
from sqlalchemy import delete, select

from test_cloud_personal_environments import PersonalCloudEnvironmentTests
from app import db, models
from app.auth import sign_token
from app.api import admin_cloud_runners, runner_ws
from app.automation_models import ExecutionSession, RunnerNode
from app.services import device_auth, runner_hub, runner_registry


class CloudRunnerAdminTests(unittest.IsolatedAsyncioTestCase):
    live = PersonalCloudEnvironmentTests.live

    async def asyncSetUp(self):
        await PersonalCloudEnvironmentTests.asyncSetUp(self)
        self.app.include_router(admin_cloud_runners.router)
        self.app.include_router(runner_ws.router)
        self.manager_id = self.prefix + '-manager'
        self.target_id = self.prefix + '-target'
        async with db.SessionLocal() as s:
            s.add(models.Role(id=self.prefix + '-role', name='Cloud manager', permissions=['runner.manage']))
            s.add_all([
                models.User(id=self.manager_id, username=self.manager_id, org_id=self.org,
                            role_id=self.prefix + '-role', is_active=True),
                models.User(id=self.target_id, username=self.target_id, org_id=self.org, is_active=True),
                models.User(id=self.prefix + '-inactive', username=self.prefix + '-inactive',
                            org_id=self.org, is_active=False),
                models.Client(id=self.prefix + '-target-device', user_ref=self.target_id, auth_state='active'),
            ])
            await s.commit()
        self.admin = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
            base_url='http://isolated', headers={'Authorization': 'Bearer ' + sign_token(self.manager_id)})
        result = await self.http.post('/api/v1/cloud-environments', json={
            'name': 'Personal cloud', 'hub': 'https://soduwork.example.test', 'workRoot': '/old-work'})
        self.assertEqual(result.status_code, 200, result.text)
        self.rid = result.json()['environment']['id']
        self.key = result.json()['setup']['key']

    async def asyncTearDown(self):
        await self.admin.aclose()
        async with db.SessionLocal() as s:
            await s.execute(delete(RunnerNode).where(RunnerNode.org_id == self.org))
            await s.commit()
        await PersonalCloudEnvironmentTests.asyncTearDown(self)

    async def action(self, suffix, data=None, *, rid=None, owner=None):
        return await self.admin.post('/api/v1/admin/cloud-runners/' + (rid or self.rid) + '/' + suffix,
            json={'expectedOwnerUserId': owner or self.user_id, **(data or {})})

    async def disable(self):
        result = await self.action('availability', {'enabled': False})
        self.assertEqual(result.status_code, 200, result.text)

    async def test_inventory_scopes_and_permissions(self):
        listing = await self.admin.get('/api/v1/admin/runners')
        self.assertEqual(listing.status_code, 200, listing.text)
        row = next(x for x in listing.json()['items'] if x['runnerId'] == self.rid)
        self.assertEqual(row['ownerUserId'], self.user_id)
        self.assertFalse(row['shared'])
        self.assertNotIn(self.key, listing.text)
        denied = await self.admin.get('/api/v1/admin/runners',
            headers={'Authorization': 'Bearer ' + sign_token(self.user_id)})
        self.assertEqual(denied.status_code, 403)
        people = (await self.admin.get('/api/v1/admin/cloud-runners/assignees')).json()['items']
        ids = {x['id'] for x in people}
        self.assertIn(self.target_id, ids)
        self.assertNotIn(self.user_id, ids)
        self.assertNotIn(self.prefix + '-inactive', ids)
        self.assertNotIn(self.prefix + '-foreign-owner', ids)
        async with db.SessionLocal() as s:
            s.add(RunnerNode(id=self.prefix + '-foreign-runner', org_id=self.foreign_org,
                            owner_user_id=self.prefix + '-foreign-owner'))
            await s.commit()
        listing = await self.admin.get('/api/v1/admin/runners')
        self.assertNotIn(self.prefix + '-foreign-runner', listing.text)
        denied = await self.action('availability', {'enabled': False},
            rid=self.prefix + '-foreign-runner', owner=self.prefix + '-foreign-owner')
        self.assertEqual(denied.status_code, 404)

    async def test_disable_cannot_be_undone_through_personal_or_legacy_routes(self):
        # Personal lifecycle controls must not expose a temporary generic
        # revocation which the owner can immediately undo by rotating keys.
        revoked = await self.admin.post('/api/v1/admin/runners/' + self.rid + '/revoke-key')
        self.assertEqual(revoked.status_code, 409, revoked.text)
        await self.disable()
        base = '/api/v1/cloud-environments/' + self.rid
        for method, url, data in [('PATCH', base, {'mode': 'accepting'}),
                ('POST', base + '/credentials', {}), ('DELETE', base, None)]:
            result = await self.http.request(method, url, json=data)
            self.assertEqual(result.status_code, 409, result.text)
        for suffix, body in [('mode', {'mode': 'accepting'}), ('issue-key', {})]:
            result = await self.admin.post('/api/v1/admin/runners/' + self.rid + '/' + suffix, json=body)
            self.assertEqual(result.status_code, 409, result.text)
        listing = (await self.http.get('/api/v1/cloud-environments')).json()['environments'][0]
        self.assertFalse(listing['canManage'])
        self.assertFalse(listing['eligible'])
        stale = await self.action('availability', {'enabled': True}, owner=self.target_id)
        self.assertEqual(stale.status_code, 409)
        enabled = await self.action('availability', {'enabled': True})
        self.assertEqual(enabled.status_code, 200, enabled.text)
        result = await self.http.patch(base, json={'mode': 'draining'})
        self.assertEqual(result.status_code, 200, result.text)

    async def test_transfer_guards_active_online_foreign_inactive_and_occupied(self):
        result = await self.action('reassign', {'targetUserId': self.target_id})
        self.assertEqual(result.status_code, 409)
        await self.disable()
        live = self.live('connected')
        runner_hub._RUNNERS.pop(live.id)
        live.id = self.rid
        runner_hub._RUNNERS[self.rid] = live
        result = await self.action('reassign', {'targetUserId': self.target_id})
        self.assertEqual(result.status_code, 409)
        runner_hub._RUNNERS.clear()
        for target in [self.prefix + '-foreign-owner', self.prefix + '-inactive']:
            result = await self.action('reassign', {'targetUserId': target})
            self.assertEqual(result.status_code, 404, result.text)
        async with db.SessionLocal() as s:
            s.add(ExecutionSession(id=self.prefix + '-active', task_id=self.prefix + '-task',
                ref=self.prefix + '-ref', runner_id=self.rid, state='queued'))
            await s.commit()
        result = await self.action('reassign', {'targetUserId': self.target_id})
        self.assertEqual(result.status_code, 409, result.text)
        async with db.SessionLocal() as s:
            active = await s.get(ExecutionSession, self.prefix + '-active')
            active.state = 'done'
            s.add(RunnerNode(id=self.prefix + '-occupied', owner_user_id=self.target_id, org_id=self.org))
            await s.commit()
        result = await self.action('reassign', {'targetUserId': self.target_id})
        self.assertEqual(result.status_code, 409, result.text)

    async def test_full_handover_uses_new_identity_preserves_history_and_requires_clean_setup(self):
        async with db.SessionLocal() as s:
            s.add(ExecutionSession(id=self.prefix + '-history', task_id=self.prefix + '-task',
                ref=self.prefix + '-ref', runner_id=self.rid, state='done'))
            await s.commit()
        await self.disable()
        result = await self.action('reassign', {'targetUserId': self.target_id})
        self.assertEqual(result.status_code, 200, result.text)
        new_id = result.json()['runnerId']
        self.assertNotEqual(new_id, self.rid)
        self.assertEqual((await self.http.get('/api/v1/cloud-environments')).json()['environments'], [])
        self.assertEqual((await self.http.patch('/api/v1/cloud-environments/' + new_id,
            json={'mode': 'accepting'})).status_code, 404)
        async with db.SessionLocal() as s:
            old = await s.get(RunnerNode, self.rid)
            self.assertEqual(old.management_state, 'retired')
            self.assertIsNone(old.owner_user_id)
            self.assertFalse(await runner_registry.verify_key(s, self.rid, self.key))
            with self.assertRaises(ValueError):
                await runner_registry.issue_key(s, self.rid)
            self.assertEqual((await s.get(ExecutionSession, self.prefix + '-history')).runner_id, self.rid)
        listing = await self.admin.get('/api/v1/admin/runners')
        self.assertNotIn(self.rid, [x['runnerId'] for x in listing.json()['items']])
        self.assertIn(new_id, [x['runnerId'] for x in listing.json()['items']])
        enabled = await self.action('availability', {'enabled': True}, rid=new_id, owner=self.target_id)
        self.assertEqual(enabled.status_code, 409)
        body = {'workRoot': '/srv/new-user/work', 'hub': 'https://soduwork.example.test'}
        invalid = await self.action('provision', {**body, 'hub': 'file:///bad',
            'hostResetConfirmed': True}, rid=new_id, owner=self.target_id)
        self.assertEqual(invalid.status_code, 422, invalid.text)
        async with db.SessionLocal() as s:
            pending = await s.get(RunnerNode, new_id)
            self.assertEqual(pending.management_state, 'pending_setup')
            self.assertFalse(pending.secret_hash)
        invalid = await self.action('provision', {**body, 'hostResetConfirmed': False},
            rid=new_id, owner=self.target_id)
        self.assertEqual(invalid.status_code, 422)
        result = await self.action('provision', {**body, 'hostResetConfirmed': True},
            rid=new_id, owner=self.target_id)
        self.assertEqual(result.status_code, 200, result.text)
        fresh_key = result.json()['key']
        self.assertNotEqual(fresh_key, self.key)
        self.assertIn(new_id, result.json()['commands']['linux'])
        async with db.SessionLocal() as s:
            self.assertTrue(await runner_registry.verify_key(s, new_id, fresh_key))
            row = await s.get(RunnerNode, new_id)
            self.assertEqual(row.management_state, 'disabled')
            self.assertEqual(row.work_root, '/srv/new-user/work')
            records = list((await s.scalars(select(models.AuditLog).where(
                models.AuditLog.actor_id == self.manager_id))).all())
            self.assertEqual({r.action for r in records}, {'runner.disable', 'runner.reassign', 'runner.reprovision'})
            self.assertNotIn(fresh_key, str([r.detail for r in records]))
        result = await self.action('availability', {'enabled': True}, rid=new_id, owner=self.target_id)
        self.assertEqual(result.status_code, 200, result.text)
        async with db.SessionLocal() as s:
            client = await s.get(models.Client, self.prefix + '-target-device')
            token = device_auth.issue_session(client)[0]
        result = await self.http.get('/api/v1/cloud-environments',
            headers={'Authorization': 'Device ' + token})
        row = result.json()['environments'][0]
        self.assertEqual(row['id'], new_id)
        self.assertTrue(row['canManage'])
        self.assertNotIn(fresh_key, result.text)

    async def test_same_owner_stale_submission_and_duplicate_transfer_are_rejected(self):
        await self.disable()
        self.assertEqual((await self.action('reassign', {'targetUserId': self.user_id})).status_code, 422)
        result = await self.action('reassign', {'targetUserId': self.target_id}, owner='stale-owner')
        self.assertEqual(result.status_code, 409)
        result = await self.action('reassign', {'targetUserId': self.target_id})
        self.assertEqual(result.status_code, 200, result.text)
        repeated = await self.action('reassign', {'targetUserId': self.target_id})
        self.assertEqual(repeated.status_code, 409, repeated.text)

    async def test_super_admin_cannot_assign_unscoped_user(self):
        async with db.SessionLocal() as s:
            (await s.get(models.User, self.manager_id)).is_super = True
            (await s.get(models.User, self.target_id)).org_id = None
            await s.commit()
        people = (await self.admin.get('/api/v1/admin/cloud-runners/assignees')).json()['items']
        self.assertNotIn(self.target_id, {u['id'] for u in people})
        await self.disable()
        result = await self.action('reassign', {'targetUserId': self.target_id})
        self.assertEqual(result.status_code, 404, result.text)

    async def test_concurrent_reassign_creates_only_one_replacement(self):
        await self.disable()
        other_id = self.prefix + '-other-recipient'
        async with db.SessionLocal() as s:
            s.add(models.User(id=other_id, username=other_id, org_id=self.org, is_active=True))
            await s.commit()
        results = await asyncio.gather(*[
            self.action('reassign', {'targetUserId': target})
            for target in (self.target_id, other_id)])
        self.assertEqual(sorted(r.status_code for r in results), [200, 409],
                         [r.text for r in results])
        async with db.SessionLocal() as s:
            replacements = list((await s.scalars(select(RunnerNode).where(
                RunnerNode.owner_user_id.in_([self.target_id, other_id])))).all())
            self.assertEqual(len(replacements), 1)


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(CloudRunnerAdminTests)


if __name__ == '__main__':
    unittest.main()
