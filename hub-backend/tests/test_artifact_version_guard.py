"""Real file-backed SQLite transactions for competing output publishers."""
import asyncio
import copy
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models, automation_models as am
from app.db import Base
from app.services import artifact_version_guard as guard, release_control, task_acceptance_review, cloud_deliveries


class ArtifactVersionGuardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='artifact-version-test-')
        self.engine = create_async_engine('sqlite+aiosqlite:///' + (Path(self.directory.name) / 'test.db').as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.exec_driver_sql('PRAGMA journal_mode=WAL')
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([models.User(id='reviewer', username='reviewer', is_active=True),
                models.Client(id='device', user_ref='reviewer', auth_state='active'),
                models.Task(id='task', title='Output', kind='requirement', status='doing',
                    created_by='reviewer', owner_client_id='device', owner_user_id='reviewer',
                    acceptance_criteria=['Correct file'])])
            await session.commit()
        self.manifest = {'complete': True, 'files': [], 'text': 'Verified output'}

    async def asyncTearDown(self):
        await self.engine.dispose()
        self.directory.cleanup()

    async def test_competing_publishers_wait_for_commit_and_reuse_one_version(self):
        started = asyncio.Event()
        async def other():
            async with self.sessions() as session:
                task = await session.get(models.Task, 'task')
                started.set()
                row, created = await release_control.ensure_output_candidate(session, task, self.manifest, 'ref')
                await session.commit()
                return row.id, created
        async with self.sessions() as first:
            task = await first.get(models.Task, 'task')
            row, created = await release_control.ensure_output_candidate(first, task, self.manifest, 'ref')
            self.assertTrue(created)
            pending = asyncio.create_task(other())
            try:
                await asyncio.wait_for(started.wait(), 3)
                await asyncio.sleep(.15)
                self.assertFalse(pending.done())
                await first.commit()
                self.assertEqual(await asyncio.wait_for(pending, 5), (row.id, False))
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
        async with self.sessions() as session:
            self.assertEqual(len((await session.scalars(select(am.ArtifactVersion))).all()), 1)
            self.assertEqual(len((await session.scalars(select(am.ApprovalRequest))).all()), 1)

    async def test_changed_content_and_reverting_content_create_new_versions(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, 'task')
            rows = []
            for text in ('first', 'second', 'first'):
                row, created = await release_control.ensure_output_candidate(session, task,
                    {**self.manifest, 'text': text}, 'ref')
                self.assertTrue(created)
                rows.append(row)
                await session.commit()
            self.assertEqual([row.seq for row in rows], [1, 2, 3])
            self.assertEqual([row.state for row in rows], ['superseded', 'superseded', 'candidate'])

    async def test_rollback_releases_fence_without_leaking_version_or_gate(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, 'task')
            await release_control.ensure_output_candidate(session, task, self.manifest, 'ref')
            await session.rollback()
        async with self.sessions() as session:
            task = await session.get(models.Task, 'task')
            row, created = await release_control.ensure_output_candidate(session, task, self.manifest, 'ref')
            self.assertTrue(created)
            self.assertEqual(row.seq, 1)
            self.assertEqual(len((await session.scalars(select(am.ApprovalRequest))).all()), 1)

    async def seed_duplicates(self, session):
        rows, requests = [], []
        for seq in (1, 2):
            row = am.ArtifactVersion(id=f'v{seq}', task_id='task', seq=seq, kind='files',
                source_ref='ref', checksum='identical', manifest={'complete': True, 'files': []}, state='candidate')
            request = am.ApprovalRequest(id=f'r{seq}', task_id='task', artifact_version_id=row.id,
                action='review', status='pending', policy_snapshot={'separationOfDuties': False},
                context={'version': seq, 'checksum': 'identical'})
            session.add_all([row, request, am.ApprovalAssignment(request_id=request.id, user_id='reviewer')])
            rows.append(row)
            requests.append(request)
        await session.commit()
        return rows, requests

    async def test_exact_undecided_duplicate_is_audited_and_keeps_latest_gate(self):
        async with self.sessions() as session:
            rows, requests = await self.seed_duplicates(session)
            task = await session.get(models.Task, 'task')
            task.kind = 'ticket'
            await session.flush()
            self.assertEqual(await guard.reconcile_identical_pending(session, 'task'), ['v1'])
            await session.commit()
            self.assertEqual([row.state for row in rows], ['superseded', 'candidate'])
            self.assertEqual([request.status for request in requests], ['cancelled', 'pending'])
            client = await session.get(models.Client, 'device')
            packet = await task_acceptance_review.context(session, client, 'task')
            self.assertEqual(packet['artifactVersionId'], 'v2')
            self.assertTrue(packet['canDecide'])
            self.assertEqual(await guard.reconcile_identical_pending(session, 'task'), [])
            events = (await session.scalars(select(models.TaskEvent).where(
                models.TaskEvent.kind == 'release.duplicate_reconciled'))).all()
            self.assertEqual(len(events), 1)
            self.assertEqual(len((await session.scalars(select(am.ApprovalDecision))).all()), 0)

    async def test_different_content_producer_policy_or_decision_is_never_reconciled(self):
        async with self.sessions() as session:
            rows, requests = await self.seed_duplicates(session)
            for obj, field, value in [(rows[0], 'manifest', {'complete': False}),
                    (rows[0], 'source_ref', 'different'), (rows[0], 'checksum', 'other'),
                    (requests[0], 'policy_snapshot', {'separationOfDuties': True}),
                    (requests[0], 'status', 'approved')]:
                previous = copy.deepcopy(getattr(obj, field))
                setattr(obj, field, value)
                await session.flush()
                self.assertEqual(await guard.reconcile_identical_pending(session, 'task'), [])
                setattr(obj, field, previous)
                await session.flush()
            session.add(am.ApprovalDecision(request_id='r1', user_id='reviewer', decision='approve'))
            await session.flush()
            self.assertEqual(await guard.reconcile_identical_pending(session, 'task'), [])
            self.assertEqual(requests[0].status, 'pending')
            self.assertEqual(rows[0].state, 'candidate')

    async def test_different_assignments_or_intervening_version_stay_blocked(self):
        async with self.sessions() as session:
            rows, requests = await self.seed_duplicates(session)
            assignment = await session.scalar(select(am.ApprovalAssignment).where(am.ApprovalAssignment.request_id == 'r1'))
            assignment.user_id = 'other-reviewer'
            await session.flush()
            self.assertEqual(await guard.reconcile_identical_pending(session, 'task'), [])
            assignment.user_id = 'reviewer'
            rows[1].seq = 3
            session.add(am.ArtifactVersion(id='intervening', task_id='task', seq=2,
                kind='files', source_ref='ref', checksum='different', manifest={'different': True}, state='superseded'))
            await session.flush()
            self.assertEqual(await guard.reconcile_identical_pending(session, 'task'), [])
            self.assertEqual([request.status for request in requests], ['pending', 'pending'])

    async def test_only_owner_retry_reconciles_ticket_and_keeps_read_context_readonly(self):
        async with self.sessions() as session:
            rows, requests = await self.seed_duplicates(session)
            task = await session.get(models.Task, 'task')
            task.kind = 'ticket'
            await session.commit()
            owner = await session.get(models.Client, 'device')
            with self.assertRaises(HTTPException):
                await task_acceptance_review.context(session, owner, 'task')
            self.assertEqual([r.status for r in requests], ['pending', 'pending'])
            with self.assertRaises(HTTPException) as caught:
                await cloud_deliveries.retry(session, models.Client(id='other', user_ref='other'), 'task')
            self.assertEqual(caught.exception.status_code, 404)
            self.assertEqual([r.status for r in requests], ['pending', 'pending'])
            await cloud_deliveries.retry(session, owner, 'task')
            self.assertEqual([r.status for r in requests], ['cancelled', 'pending'])


if __name__ == '__main__':
    unittest.main()
