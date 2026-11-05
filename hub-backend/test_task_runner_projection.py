import unittest
from types import SimpleNamespace as Row
from unittest.mock import AsyncMock, Mock

from app.services import ai_exec, tasks


def result(rows):
    return Mock(scalars=Mock(return_value=Mock(all=Mock(return_value=rows))))


class RunnerProjectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_list_projects_actual_pc_cloud_and_unknown_without_transcripts(self):
        events = [Row(task_id=key, kind=ai_exec.EV_DISPATCHED,
                      detail={'ref': key, 'assigneeName': 'Pi'})
                  for key in ['pc', 'cloud', 'unknown']]
        sessions = [Row(task_id=key, ref=key, state='done', metadata_={'executionContext': {'runner': runner}})
                    for key, runner in [('pc', {'mode': 'remote', 'clientId': 'owned-pc'}),
                                        ('cloud', {'mode': 'remote'}), ('unknown', {})]]
        session = Row(execute=AsyncMock(side_effect=[result(events), result(sessions)]))
        rows = await tasks.ai_states(session, ['pc', 'cloud', 'unknown'])
        self.assertEqual(rows['pc']['runnerKind'], 'work-computer')
        self.assertEqual(rows['cloud']['runnerKind'], 'cloud')
        self.assertNotIn('runnerKind', rows['unknown'])
        self.assertTrue(all(row['executionState'] == 'done' for row in rows.values()))
        self.assertEqual(session.execute.await_count, 2)

    async def test_same_ref_on_another_task_cannot_supply_location_or_state(self):
        event = Row(task_id='mine', kind=ai_exec.EV_DISPATCHED, detail={'ref': 'shared-ref'})
        foreign = Row(task_id='other', ref='shared-ref', state='done',
                      metadata_={'executionContext': {'runner': {'mode': 'remote', 'clientId': 'foreign'}}})
        session = Row(execute=AsyncMock(side_effect=[result([event]), result([foreign])]))
        row = (await tasks.ai_states(session, ['mine']))['mine']
        self.assertNotIn('runnerKind', row)
        self.assertNotIn('executionState', row)
        self.assertEqual(row['state'], 'running')
