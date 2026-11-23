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

    async def test_reassessment_alone_cannot_replace_a_rejected_file_version(self):
        original = {"name": "delivery.md", "id": "v1-file", "category": "primary", "sha256": "original"}
        report = {"name": "findings.md", "id": "report", "category": "primary", "sha256": "assessment"}
        async with self.sessions() as session:
            task = await session.get(models.Task, 'task')
            v1, _ = await release_control.ensure_output_candidate(
                session, task, {"files": [original], "complete": True}, "conversation:example")
            request = await release_control.ensure_request(session, task, v1, "review")
            v1.state = request.status = "rejected"
            await session.commit()

            for files in ([original], [original, report], [report], [{**original, "id": "reupload"}, report]):
                with self.subTest(files=files), self.assertRaisesRegex(ValueError, "修改原交付"):
                    await release_control.ensure_output_candidate(session, task, {"files": files, "complete": True})
            self.assertEqual(await release_control.latest_artifact(session, task.id), v1)
            self.assertEqual(v1.manifest["files"], [original])
            self.assertEqual((await session.scalars(select(am.ApprovalRequest))).all(), [request])

            revised = {**original, "id": "corrected", "sha256": "amended"}
            v2, created = await release_control.ensure_output_candidate(
                session, task, {"files": [revised, report], "complete": True})
            self.assertTrue(created)
            gate = await release_control.ensure_request(session, task, v2, "review")
            self.assertEqual((v2.seq, gate.status, request.status), (2, "pending", "rejected"))
            self.assertEqual(v1.manifest["files"], [original])

    def test_file_rework_preserves_real_replacements_and_supporting_changes(self):
        primary = {"name": "docs/report.md", "category": "primary", "sha256": "old"}
        asset = {"name": "docs/style.css", "category": "supporting", "sha256": "css"}
        version = am.ArtifactVersion(manifest={"files": [primary, asset]})
        for replacement in [
                {"name": "docs/report-v2.md"}, {"name": "docs/report.html"},
                {"name": "final.pdf", "replaces": ["docs/report.md"]},
                {"name": "new-name.csv", "requestedOutput": True}]:
            with self.subTest(replacement=replacement):
                guard.require_revised_files(version, {"files": [{**replacement, "sha256": "revised"}]})
        guard.require_revised_files(version, {"files": [primary, {**asset, "sha256": "new-css"}]})
        with self.assertRaises(ValueError):
            guard.require_revised_files(version, {"files": [
                {**asset, "sha256": "new-css"}, {"name": "findings.md", "sha256": "new"}]})
        code = am.ArtifactVersion(manifest={"files": [{"name": "total.cjs", "sha256": "old"}]})
        with self.assertRaises(ValueError):
            guard.require_revised_files(code, {"files": [{"name": "total.md", "sha256": "review"}]})
        for replacement in [
                {"name": "unrelated/report.md"}, {"name": "docs/report-v2.md", "sha256": "old"},
                {"name": "report.pdf", "replaces": ["unrelated-file.md"]}]:
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                guard.require_revised_files(version, {"files": [{"sha256": "new", **replacement}]})

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
