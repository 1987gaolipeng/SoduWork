"""ACP diagnostics and DSH output recovery preserve native execution evidence."""
import io
import json
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app.services import acp_bridge as bridge


class AcpErrorMessagesTests(unittest.TestCase):
    raw = (r"Internal error: turn failed: MoveFileExW EXDEV (Win32 17): "
           r"D:\private\.dsh\sessions\project\session\session.v4.jsonl.zstd.abc123.tmp"
           r" -> D:\private\.dsh\sessions\project\session\session.v4.jsonl.zstd")

    def setUp(self):
        environment = patch.dict(bridge.os.environ, {
            'SODUWORK_APPROVAL_CHANNEL': '', bridge.runtime_images.ENV_KEY: '',
            bridge._TASK_OUTPUT_RECOVERY_ENV: '',
        })
        environment.start()
        self.addCleanup(environment.stop)

    def test_known_dsh_storage_error_is_actionable_and_keeps_original(self):
        for message in (self.raw, self.raw.replace("\\", "/"),
                        self.raw.replace(".zstd", "")):
            with self.subTest(message=message):
                result = bridge._friendly_bridge_error("dsh", message)
                self.assertIn("无法保存本机会话归档", result)
                self.assertIn("本次执行未完成", result)
                self.assertIn("重新登录或放宽工具权限不能解决", result)
                self.assertTrue(result.endswith("原始信息：" + message))

    def test_other_agents_keep_their_native_error(self):
        for agent in ("qwen", "opencode", "codex-harness", "acp", "dsh-other"):
            with self.subTest(agent=agent):
                self.assertEqual(bridge._friendly_bridge_error(agent, self.raw), self.raw)

    def test_unrelated_paths_and_error_codes_are_not_classified(self):
        cases = [self.raw.replace("session.v4.jsonl", name) for name in (
            "auth.json", "session.v3.jsonl", "session.v4.jsonl-other", "workspace.json")]
        cases += [self.raw.replace("EXDEV (Win32 17)", name) for name in (
            "EACCES (Win32 5)", "ENOENT (Win32 2)", "EXDEV", "EXDEV (Win32 117)")]
        cases.append(self.raw.replace("MoveFileExW", "rename"))
        for message in cases:
            with self.subTest(message=message):
                self.assertEqual(bridge._friendly_bridge_error("dsh", message), message)

    def test_authentication_guidance_still_preserves_original(self):
        message = "Authentication required: Use Qwen Code CLI to authenticate first."
        result = bridge._friendly_bridge_error("qwen", message)
        self.assertIn("qwen 缺少可用的模型凭据", result)
        self.assertTrue(result.endswith("原始信息：" + message))

    def test_unknown_error_is_unchanged(self):
        message = "Internal error: upstream unavailable"
        self.assertEqual(bridge._friendly_bridge_error("dsh", message), message)

    def test_kimi_and_verified_qwen_output_limits_do_not_add_host_retries(self):
        cases = [
            ('kimi', {}, True),
            ('qwen', {'soduwork': {'outputLimit': True}}, True),
            ('qwen', {}, False),
            ('qwen', {'soduwork': {'outputLimit': 'true'}}, False),
            ('qwen', {'soduwork': {'outputLimit': 1}}, False),
            ('qwen', {'soduwork': 'outputLimit'}, False),
            ('qwen', [], False),
            ('other', {'soduwork': {'outputLimit': True}}, False),
        ]
        for agent, metadata, incomplete in cases:
            with self.subTest(agent=agent, metadata=metadata), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, agent, 'workspace', session_id='retained-native')
                prompts = []

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}
                    self.assertEqual(params['sessionId'], 'retained-native')
                    if method == 'session/load':
                        return {}
                    self.assertEqual(method, 'session/prompt')
                    prompts.append(params['prompt'])
                    return {'stopReason': 'max_tokens', '_meta': metadata}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), patch.object(bridge.qwen_runtime, 'apply_model'), \
                        patch.object(bridge, '_emit') as emit:
                    if incomplete:
                        self.assertEqual(acp.run('Preserve existing work'), 2)
                    else:
                        with self.assertRaises(bridge.BridgeError):
                            acp.run('Preserve existing work')
                self.assertEqual(prompts, [[{'type': 'text', 'text': 'Preserve existing work'}]])
                endings = [call.args[0]['part']['reason'] for call in emit.call_args_list
                           if call.args[0].get('type') == 'step_finish']
                self.assertEqual(endings, ['max_tokens'] if incomplete else [])

    def test_dsh_output_recovery_is_bounded_and_keeps_the_original_session(self):
        compacted = 'Compacted 4 history items (~32000 tokens).'
        for agent, reasons, tool_status, compact_reply, resumes, succeeds in [
            ('dsh', ['max_tokens', 'end_turn'], None, None, 1, True),
            ('dsh', ['max_tokens', 'max_tokens'], None, None, 1, False),
            ('dsh', ['max_tokens', 'max_tokens', 'end_turn'], None, compacted, 2, True),
            ('dsh', ['max_tokens'] * 3, None, compacted, 2, False),
            ('dsh', ['max_tokens'] * 2, None, 'No compactable history yet.', 1, False),
            ('dsh', ['max_tokens'] * 2, None, '⚠ Compaction cancelled.', 1, False),
            ('dsh', ['max_tokens'], 'in_progress', compacted, 0, False),
            ('dsh', ['max_tokens'], 'pending', compacted, 0, False),
            ('qwen', ['max_tokens'], None, None, 0, False),
        ]:
            with self.subTest(agent=agent, reasons=reasons, tool_status=tool_status, compact_reply=compact_reply), \
                    TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, agent, 'workspace')
                seen = []
                stops = iter(reasons)

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1}
                    if method == 'session/new':
                        if compact_reply is not None:
                            acp._update({'sessionUpdate': 'available_commands_update',
                                         'availableCommands': [{'name': 'compact'}]})
                        return {'sessionId': 'existing-tools'}
                    self.assertEqual(method, 'session/prompt')
                    seen.append(params)
                    if params['prompt'][0]['text'] == '/compact':
                        acp._update({'sessionUpdate': 'agent_message_chunk',
                                     'content': {'type': 'text', 'text': compact_reply}})
                        return {'stopReason': 'end_turn'}
                    if tool_status:
                        acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'running-tool',
                                     'title': 'Unsettled fixture', 'status': tool_status})
                    return {'stopReason': next(stops)}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), \
                        patch.object(bridge.qwen_runtime, 'apply_model'), patch.object(bridge, '_emit') as emit:
                    if succeeds:
                        self.assertEqual(acp.run('Original synthetic task'), 0)
                    elif agent == 'dsh':
                        self.assertEqual(acp.run('Original synthetic task'), 2)
                    else:
                        with self.assertRaises(bridge.BridgeError):
                            acp.run('Original synthetic task')
                self.assertEqual({p['sessionId'] for p in seen}, {'existing-tools'})
                texts = [p['prompt'][0]['text'] for p in seen]
                expected = ['Original synthetic task'] + [bridge._DSH_OUTPUT_CONTINUATION] * resumes
                if compact_reply is not None and resumes:
                    expected.insert(2, '/compact')
                self.assertEqual(texts, expected)
                if agent == 'dsh':
                    finish_reasons = [call.args[0]['part']['reason'] for call in emit.call_args_list
                                      if call.args[0].get('type') == 'step_finish'
                                      and not call.args[0].get('contextOnly')]
                    self.assertEqual(finish_reasons, [
                        'stop' if reason == 'end_turn' else reason for reason in reasons])
                    self.assertFalse(any(call.args[0].get('error')
                                         for call in emit.call_args_list))
                if compact_reply:
                    self.assertNotIn(compact_reply, str(emit.call_args_list))

    def test_task_owned_recovery_does_not_multiply_retries_across_bridge_restarts(self):
        with TemporaryDirectory() as folder, patch.dict(bridge.os.environ, {
                bridge._TASK_OUTPUT_RECOVERY_ENV: '1'}):
            # Each new bridge attaches to the same native session. Neither an
            # output limit nor an available compact command grants extra tries.
            for _attempt in range(3):
                acp = bridge.AcpBridge([], folder, 'dsh', 'workspace', session_id='saved-task')
                prompts = []

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}
                    self.assertEqual(params['sessionId'], 'saved-task')
                    if method == 'session/load':
                        acp.dsh_can_compact = True
                        return {}
                    self.assertEqual(method, 'session/prompt')
                    prompts.append(params['prompt'][0]['text'])
                    return {'stopReason': 'max_tokens'}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit, \
                        patch.object(acp, '_compact_dsh_history') as compact:
                    self.assertEqual(acp.run('Continue the retained task'), 2)
                compact.assert_not_called()
                self.assertEqual(prompts, ['Continue the retained task'])
                self.assertEqual([call.args[0]['part']['reason'] for call in emit.call_args_list
                                  if call.args[0].get('type') == 'step_finish'], ['max_tokens'])
                self.assertFalse(any(call.args[0].get('error') for call in emit.call_args_list))

    def test_task_owned_recovery_requires_the_exact_host_flag(self):
        with TemporaryDirectory() as folder:
            for value in ('', '0', 'true', 'yes', '1 ', '1'):
                with self.subTest(value=value), patch.dict(bridge.os.environ, {
                        bridge._TASK_OUTPUT_RECOVERY_ENV: value}):
                    acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
                    self.assertEqual(acp.task_output_recovery_owned, value == '1')

    def test_task_recovery_control_is_not_exposed_to_native_agent_tools(self):
        with TemporaryDirectory() as folder, patch.dict(bridge.os.environ, {
                bridge._TASK_OUTPUT_RECOVERY_ENV: '1'}):
            acp = bridge.AcpBridge(['synthetic-agent'], folder, 'dsh', 'workspace')
            with patch.object(bridge.subprocess, 'Popen') as spawn, \
                    patch.object(bridge, 'OwnedProcessGroup'), patch.object(bridge.threading, 'Thread'):
                acp.start()
            self.assertTrue(acp.task_output_recovery_owned)
            self.assertNotIn(bridge._TASK_OUTPUT_RECOVERY_ENV, spawn.call_args.kwargs['env'])

    def test_task_owned_recovery_never_masks_a_protocol_or_context_failure(self):
        with TemporaryDirectory() as folder, patch.dict(bridge.os.environ, {
                bridge._TASK_OUTPUT_RECOVERY_ENV: '1'}):
            for error in ('Connection closed', 'context_length_exceeded'):
                with self.subTest(error=error):
                    acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
                    prompts = []

                    def request(method, params):
                        if method == 'initialize':
                            return {'protocolVersion': 1}
                        if method == 'session/new':
                            return {'sessionId': 'saved-task'}
                        prompts.append(params['prompt'])
                        raise bridge.BridgeError(error)

                    with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                            patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit:
                        with self.assertRaisesRegex(bridge.BridgeError, error):
                            acp.run('Continue the retained task')
                    self.assertEqual(len(prompts), 1)
                    self.assertFalse(any(call.args[0].get('type') == 'step_finish'
                                         for call in emit.call_args_list))

    def test_dsh_unexecuted_preview_allows_one_continuation_in_the_saved_session(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, 'dsh', 'workspace', session_id='saved-tools')
            methods, prompts = [], []

            def request(method, params):
                methods.append(method)
                if method == 'initialize':
                    return {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}
                self.assertEqual(params['sessionId'], 'saved-tools')
                if method == 'session/load':
                    return {}
                self.assertEqual(method, 'session/prompt')
                prompts.append(params['prompt'][0]['text'])
                if len(prompts) == 1:
                    acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'completed-edit',
                                 'title': 'Completed edit', 'status': 'in_progress'})
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'completed-edit',
                                 'status': 'completed'})
                    acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'partial-edit',
                                 'title': 'Partial edit', 'status': 'pending',
                                 'rawInput': {'path': 'synthetic.txt'}})
                    self.assertTrue(acp.transition.busy())
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'partial-edit',
                                 'status': 'failed', '_meta': {'soduwork': {
                                     'toolOutcome': 'not-executed', 'reason': 'output-limit'}}})
                    self.assertFalse(acp.transition.busy())
                    return {'stopReason': 'max_tokens'}
                self.assertEqual(len(prompts), 2, 'Only the saved-session continuation may follow')
                self.assertEqual(acp.transition.tools['completed-edit'], 'completed')
                self.assertEqual(acp.transition.tools['partial-edit'], 'failed')
                return {'stopReason': 'end_turn'}

            with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                    patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit:
                self.assertEqual(acp.run('Original synthetic task'), 0)
            self.assertEqual(methods, ['initialize', 'session/load', 'session/prompt', 'session/prompt'])
            self.assertEqual(prompts, ['Original synthetic task', bridge._DSH_OUTPUT_CONTINUATION])
            events = [call.args[0] for call in emit.call_args_list]
            endings = [event for event in events if event.get('type') == 'tool_execution_end']
            self.assertEqual(len(endings), 2)
            preview = next(event for event in endings if event['toolCallId'] == 'partial-edit')
            self.assertEqual(preview['state'], 'cancelled')
            self.assertEqual(preview['cancelReason'], 'output-limit')
            self.assertIs(preview['isError'], False)
            self.assertEqual([event['part']['reason'] for event in events
                              if event.get('type') == 'step_finish'], ['max_tokens', 'stop'])

    def test_dsh_started_tool_rejects_unexecuted_marker_and_blocks_continuation(self):
        for statuses in (('in_progress',), ('pending', 'in_progress'),
                         ('in_progress', 'pending')):
            with self.subTest(statuses=statuses), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
                prompts = []

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1}
                    if method == 'session/new':
                        return {'sessionId': 'running-tools'}
                    self.assertEqual(method, 'session/prompt')
                    prompts.append(params['prompt'][0]['text'])
                    self.assertEqual(len(prompts), 1, 'A started tool must block automatic continuation')
                    for index, status in enumerate(statuses):
                        acp._update({'sessionUpdate': 'tool_call' if index == 0 else 'tool_call_update',
                                     'toolCallId': 'running-edit', 'status': status})
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'running-edit',
                                 'status': 'failed', '_meta': {'soduwork': {
                                     'toolOutcome': 'not-executed', 'reason': 'output-limit'}}})
                    self.assertTrue(acp.transition.busy())
                    self.assertEqual(acp.transition.tools['running-edit'], statuses[-1])
                    return {'stopReason': 'max_tokens'}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit:
                    self.assertEqual(acp.run('Original synthetic task'), 2)
                self.assertEqual(prompts, ['Original synthetic task'])
                self.assertFalse(any(call.args[0].get('type') == 'tool_execution_end'
                                     for call in emit.call_args_list))

    def test_only_known_pending_dsh_previews_receive_output_limit_cancellation(self):
        marker = {'soduwork': {'toolOutcome': 'not-executed', 'reason': 'output-limit'}}
        cases = [
            ('dsh', 'pending', None),
            ('dsh', 'pending', {'soduwork': {'toolOutcome': 'not-executed', 'reason': 'other'}}),
            ('dsh', 'pending', {'soduwork': {'toolOutcome': 'failed', 'reason': 'output-limit'}}),
            ('dsh', 'pending', {'soduwork': 'not-executed'}),
            ('dsh', 'pending', 'not-executed'),
            ('dsh', None, marker),
            ('dsh', 'completed', marker),
            ('qwen', 'pending', marker),
            ('codex-harness', 'pending', marker),
            ('opencode', 'pending', marker),
        ]
        for agent, previous, metadata in cases:
            with self.subTest(agent=agent, previous=previous, metadata=metadata), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, agent, 'workspace')
                with patch.object(bridge, '_emit') as emit:
                    if previous:
                        acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'untrusted-preview',
                                     'status': previous})
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'untrusted-preview',
                                 'status': 'failed', '_meta': metadata})
                endings = [call.args[0] for call in emit.call_args_list
                           if call.args[0].get('type') == 'tool_execution_end']
                if agent == 'dsh' and metadata == marker and previous in (None, 'completed'):
                    self.assertEqual(endings, [])
                    self.assertEqual(acp.transition.tools.get('untrusted-preview'), previous)
                    continue
                self.assertEqual(len(endings), 1)
                self.assertIs(endings[0]['isError'], True)
                self.assertNotIn('cancelReason', endings[0])
                self.assertNotEqual(endings[0].get('state'), 'cancelled')

    def test_dsh_duplicate_marker_and_reused_tool_ids_preserve_each_execution(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
            marker = {'sessionUpdate': 'tool_call_update', 'toolCallId': 'reused-tool',
                      'status': 'failed', '_meta': {'soduwork': {
                          'toolOutcome': 'not-executed', 'reason': 'output-limit'}}}
            with patch.object(bridge, '_emit') as emit:
                acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'reused-tool',
                             'status': 'in_progress'})
                acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'reused-tool',
                             'status': 'completed'})
                acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'reused-tool',
                             'status': 'pending'})
                acp._update(marker)
                acp._update(marker)
                self.assertFalse(acp.transition.busy())
                acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'reused-tool',
                             'status': 'in_progress'})
                self.assertTrue(acp.transition.busy())
                acp._update(marker)
                self.assertTrue(acp.transition.busy())
                acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'reused-tool',
                             'status': 'failed'})
                acp._update(marker)
            endings = [call.args[0] for call in emit.call_args_list
                       if call.args[0].get('type') == 'tool_execution_end']
            self.assertEqual(len(endings), 3, 'Duplicate and conflicting markers must emit no terminal event')
            self.assertIs(endings[0]['isError'], False)
            self.assertNotIn('cancelReason', endings[0])
            self.assertEqual(endings[1]['cancelReason'], 'output-limit')
            self.assertIs(endings[1]['isError'], False)
            self.assertIs(endings[2]['isError'], True)
            self.assertNotIn('cancelReason', endings[2])

    def test_dsh_later_real_failure_overrides_an_earlier_discard_marker(self):
        for starts_late in (False, True):
            with self.subTest(starts_late=starts_late), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
                with patch.object(bridge, '_emit') as emit:
                    acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'late-failure',
                                 'status': 'pending'})
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'late-failure',
                                 'status': 'failed', '_meta': {'soduwork': {
                                     'toolOutcome': 'not-executed', 'reason': 'output-limit'}}})
                    if starts_late:
                        acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'late-failure',
                                     'status': 'in_progress'})
                        self.assertTrue(acp.transition.busy())
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'late-failure',
                                 'status': 'failed', 'content': [
                                     {'type': 'content', 'content': {'type': 'text', 'text': 'Real execution failed'}}]})
                endings = [call.args[0] for call in emit.call_args_list
                           if call.args[0].get('type') == 'tool_execution_end']
                self.assertEqual(len(endings), 2)
                self.assertEqual(endings[0]['cancelReason'], 'output-limit')
                self.assertIs(endings[1]['isError'], True)
                self.assertNotIn('cancelReason', endings[1])
                self.assertIn('Real execution failed', endings[1]['result'])

    def test_dsh_discarded_preview_does_not_fail_a_pending_permission_change(self):
        for started in (False, True):
            with self.subTest(started=started), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, 'dsh', 'workspace', session_id='saved-tools')
                acp.access.channel = {}
                acp.transition.cancel_sent = True
                acp.transition.requested = 'change-1'
                terminal = {'sessionUpdate': 'tool_call_update', 'toolCallId': 'late-tool', 'status': 'failed'}
                if not started:
                    terminal['_meta'] = {'soduwork': {'toolOutcome': 'not-executed', 'reason': 'output-limit'}}
                with patch.object(bridge, '_emit'), patch.object(acp.access, 'call',
                        return_value={'requested': True, 'id': 'change-1'}) as control:
                    acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'late-tool',
                                 'status': 'in_progress' if started else 'pending'})
                    acp._update(terminal)
                    self.assertFalse(acp.transition.busy())
                    self.assertEqual(acp.transition.failed_after_cancel, {'late-tool'} if started else set())
                    self.assertEqual(acp.transition.complete({'stopReason': 'cancelled'}), not started)
                self.assertEqual(control.call_args.args[1]['stage'], 'failed' if started else 'ready')

    def test_real_bridge_entry_emits_failure_and_always_closes(self):
        args = SimpleNamespace(agent=["fixture"], cwd="fixture", agent_name="dsh",
                               permission="workspace", session="", terminal=False)
        agent = Mock(agent_name="dsh")
        agent.run.side_effect = bridge.BridgeError(self.raw)
        output = io.StringIO()
        with patch.object(bridge, "_parse", return_value=args), \
                patch.object(bridge, "_utf8_stdio"), \
                patch.object(bridge, "AcpBridge", return_value=agent), \
                patch.object(bridge.sys, "stdin", io.StringIO("synthetic")), \
                patch.object(bridge.sys, "stdout", output):
            code = bridge.main()
        self.assertEqual(code, 2)
        event = json.loads(output.getvalue())
        self.assertEqual(event["error"]["name"], "AcpBridgeError")
        self.assertEqual(event["error"]["message"], bridge._friendly_bridge_error("dsh", self.raw))
        agent.run.assert_called_once_with("synthetic")
        agent.close.assert_called_once_with()

    def test_dsh_output_limit_entry_returns_two_without_an_adapter_error(self):
        with TemporaryDirectory() as folder:
            args = SimpleNamespace(agent=['fixture'], cwd=folder, agent_name='dsh',
                                   permission='workspace', session='', terminal=False)
            acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')

            def request(method, _params):
                if method == 'initialize':
                    return {'protocolVersion': 1}
                if method == 'session/new':
                    return {'sessionId': 'output-limit-session'}
                self.assertEqual(method, 'session/prompt')
                return {'stopReason': 'max_tokens'}

            output = io.StringIO()
            with patch.object(bridge, '_parse', return_value=args), \
                    patch.object(bridge, '_utf8_stdio'), \
                    patch.object(bridge, 'AcpBridge', return_value=acp), \
                    patch.object(bridge.sys, 'stdin', io.StringIO('synthetic')), \
                    patch.object(bridge.sys, 'stdout', output), \
                    patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                    patch.object(acp.access, 'apply'), patch.object(acp, 'close', wraps=acp.close) as close:
                self.assertEqual(bridge.main(), 2)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertFalse(any(event.get('error') for event in events))
            self.assertEqual([event['part']['reason'] for event in events
                              if event.get('type') == 'step_finish'], ['max_tokens', 'max_tokens'])
            close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
