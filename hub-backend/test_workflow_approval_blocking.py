"""Mandatory human gates must fail closed, independently of the client form."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from app.services import workflow_engine as workflow


class HumanGateTests(unittest.IsolatedAsyncioTestCase):
    async def poll(self, status, node_type='spec', deployment=None):
        task = SimpleNamespace(id='isolated-task')
        req = None if status is None else SimpleNamespace(
            id='isolated-approval', status=status, environment_id='test-environment')
        session = SimpleNamespace(get=AsyncMock(side_effect=[task, req]), add=Mock())
        run = SimpleNamespace(id='isolated-run', task_id=task.id)
        node = SimpleNamespace(id='isolated-node', node_key='confirm', node_type=node_type,
                               state='waiting_human', error='', output={'requestId': 'isolated-approval'},
                               attempt=1, finished_at=None)
        with patch.object(workflow, '_event') as events, \
                patch.object(workflow, '_node_config', AsyncMock(return_value={})), \
                patch.object(workflow, '_begin_rework', AsyncMock(return_value=False)), \
                patch.object(workflow, '_rework_evidence', return_value='changes requested'), \
                patch.object(workflow.release_control, '_decisions', AsyncMock(return_value=[])), \
                patch.object(workflow.deployments, 'request_environment',
                             AsyncMock(return_value=deployment or {'ok': True})) as deploy:
            await workflow._poll_node(session, run, node)
        return node, session, events, deploy

    async def test_pending_missing_revoked_and_unknown_requests_do_not_release_gate(self):
        for status in ['pending', None, 'revoked', 'waiting', 'unknown']:
            with self.subTest(status=status):
                node, session, events, deploy = await self.poll(status)
                self.assertEqual(node.state, 'waiting_human')
                self.assertIsNone(node.finished_at)
                session.add.assert_not_called()
                events.assert_not_called()
                deploy.assert_not_awaited()

    async def test_rejection_or_cancellation_cannot_succeed(self):
        for status in ['rejected', 'cancelled']:
            node, session, _, deploy = await self.poll(status)
            self.assertEqual(node.state, 'failed')
            session.add.assert_not_called()
            deploy.assert_not_awaited()

    async def test_approved_human_gate_succeeds(self):
        node, _, events, _ = await self.poll('approved')
        self.assertEqual(node.state, 'succeeded')
        self.assertIsNotNone(node.finished_at)
        events.assert_called_once()

    async def test_deploy_approval_authorizes_execution_but_is_not_deployment_success(self):
        node, _, _, deploy = await self.poll('approved', 'deploy')
        self.assertEqual(node.state, 'waiting_external')
        self.assertIsNone(node.finished_at)
        deploy.assert_awaited_once()

    async def test_deploy_authorization_still_pending_does_not_release(self):
        node, _, _, _ = await self.poll('approved', 'deploy', {'ok': True, 'pendingApproval': True})
        self.assertEqual(node.state, 'waiting_human')

    async def test_merge_approval_queues_real_execution_not_a_success_receipt(self):
        node, session, _, _ = await self.poll('approved', 'merge')
        self.assertEqual(node.state, 'queued')
        self.assertIsNone(node.finished_at)
        self.assertEqual(session.add.call_args.args[0].topic, 'node.execute')


if __name__ == '__main__':
    unittest.main()
