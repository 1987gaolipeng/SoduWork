"""Actual broker channels and literal command scopes; never execute a shell."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from app.services import access_broker, access_command_scope as scope, access_policy, local_base
from app.services.skill_read_scope import ReadScope


class PreviewScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='soduwork-preview-permission-')
        self.base = Path(self.temp.name)
        self.root = self.base / 'workspace'
        self.root.mkdir()
        self.page = self.root / 'index.html'
        self.page.write_text('<h1>Preview</h1>', encoding='utf-8')
        self.package = self.base / 'builtin/browser-use'
        self.script = self.package / 'scripts/browser.mjs'
        self.script.parent.mkdir(parents=True)
        self.script.write_text('// isolated trusted script fixture', encoding='utf-8')
        self.read_scope = ReadScope.capture([str(self.package)])
        self.policy = access_policy.normalize(dict(schema=access_policy.SCHEMA, mode='standard',
            revision=1, workspaceRoot=str(self.root), sessionId='chat-test'))
        self.ref = self.base.name
        local_base._RUNS[self.ref] = dict(state='running', ws=str(self.root), accessPolicy=self.policy,
            cli='codex-harness', _skillReadScope=self.read_scope, lines=[], seq=0)
        self.patches = [patch.object(scope, '_builtin_roots', return_value=[self.package]),
                        patch.object(local_base, '_STORE', str(self.base / 'history'))]
        for item in self.patches:
            item.start()
        self.channel = access_broker.Channel(self.ref, self.policy, 'codex-harness')
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.channel.close()
        local_base._RUNS.pop(self.ref, None)
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def operation(self, body, **extra):
        shell = str(Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
        command = json.dumps(shell) + ' -NoProfile -Command ' + json.dumps(body)
        return dict(action='native.command', kind='execute', tool='codex.shell', title='Preview',
                    target=command, arguments=dict(command=command, cwd=str(self.root), itemId='call-1',
                    turnId='turn-1', threadId='thread-1', reason='Preview the page'), **extra)

    def browser(self, args):
        return f'node "{self.script}" {args} --session chat-test'

    def start(self, operation):
        result = []
        thread = threading.Thread(target=lambda: result.append(self.channel.request(operation)))
        thread.start()
        deadline = time.monotonic() + 2
        while not self.channel.pending and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(self.channel.pending, 'Expected an explicit user decision')
        return thread, result, next(iter(self.channel.pending.values()))

    def reply(self, row, decision, thread):
        self.assertTrue(self.channel.respond(row['requestId'], decision, 1)['ok'])
        thread.join(3)
        self.assertFalse(thread.is_alive())

    def test_exact_native_command_grant_ignores_transport_ids_but_not_execution(self):
        first = self.operation('node --version')
        thread, result, row = self.start(first)
        self.reply(row, 'session', thread)
        changed = {**first, 'title': 'Check again', 'arguments': {
            **first['arguments'], 'itemId': 'new-call', 'turnId': 'new-turn', 'reason': 'Recheck'}}
        self.assertEqual(self.channel.request(changed), 'once')
        for key, value in [('command', 'node malicious.js'), ('cwd', str(self.base)), ('env', {'MODE': 'other'})]:
            other = {**changed, 'arguments': {**changed['arguments'], key: value}}
            thread, result, row = self.start(other)
            self.reply(row, 'deny', thread)
            self.assertEqual(result, ['deny'])

    @unittest.skipUnless(os.name == 'nt', 'Windows shell scopes require the real Windows executable')
    def test_explicit_preview_grant_covers_varying_previews_and_next_turn(self):
        first = self.operation(self.browser(f'shot "{self.page.as_uri()}" "one.png"'))
        thread, result, row = self.start(first)
        self.assertEqual(row['sessionScope'], {'kind': 'browser-preview'})
        self.reply(row, 'session', thread)
        for command in [self.browser('shot current "two.png"'), self.browser('errors current'),
                        self.browser('eval current "document.title"'),
                        self.browser('eval current "window.scrollTo(0,980)"'),
                        self.browser('eval current "window.scrollTo(0,2100)"') + '; Start-Sleep -Milliseconds 700; ' + self.browser('shot current "middle.png"'),
                        self.browser('do current \'[{"eval":"window.scrollTo(0,980)"},{"wait":50},{"shot":"three.png"}]\''),
                        self.browser(f'goto "{self.page.as_uri()}#footer"') + '; Start-Sleep -Seconds 1; ' + self.browser('shot current "four.png"')]:
            self.assertEqual(self.channel.request(self.operation(command)), 'once', command)
            self.assertFalse(self.channel.pending)
        self.channel.close()
        self.channel = access_broker.Channel(self.ref, self.policy, 'codex-harness')
        self.assertEqual(self.channel.request(self.operation(self.browser('shot current "next.png"'))), 'once')

    @unittest.skipUnless(os.name == 'nt', 'Windows shell scopes require the real Windows executable')
    def test_once_and_deny_do_not_grant_the_preview_family(self):
        operation = self.operation(self.browser('shot current "first.png"'))
        thread, result, row = self.start(operation)
        self.reply(row, 'once', thread)
        thread, result, row = self.start(self.operation(self.browser('shot current "second.png"')))
        self.reply(row, 'deny', thread)
        thread, result, row = self.start(self.operation(self.browser('shot current "third.png"')))
        self.reply(row, 'once', thread)
        self.assertFalse(self.channel.grants)

    @unittest.skipUnless(os.name == 'nt', 'Windows shell scopes require the real Windows executable')
    def test_unknown_scripts_code_network_and_outside_paths_never_get_preview_scope(self):
        bad = [self.browser('eval current "fetch(\'https://example.invalid\')"'),
               self.browser('goto current'), self.browser('shot current "C:relative.png"'),
               self.browser('goto "https://example.invalid"'), self.browser('shot current "../outside.png"'),
               self.browser('shot current ".ssh/key.png"'), self.browser('shot current "inside.png"') + '; Remove-Item index.html',
               self.browser('shot current "inside.png"') + ' | Invoke-Expression',
               self.browser('eval current "$env:HOME"'), self.browser('eval current "`(Get-Content secret)"'),
               self.browser('do current \'[{"upload":"secret"}]\''), self.browser('shot current "x.png"').replace('chat-test', 'other'),
               self.browser('shot current "x.png"').replace(str(self.script), str(self.root / 'browser.mjs'))]
        for command in bad:
            self.assertIsNone(scope.preview_scope(self.operation(command), self.policy, self.read_scope), command)
        operation = self.operation(self.browser('shot current "yes.png"'))
        self.assertIsNotNone(scope.preview_scope(operation, self.policy, self.read_scope))
        for key, value in [('env', {'NODE_OPTIONS': '--require malicious.js'}), ('additionalPermissions', {'network': True})]:
            modified = {**operation, 'arguments': {**operation['arguments'], key: value}}
            self.assertIsNone(scope.preview_scope(modified, self.policy, self.read_scope))
        self.assertIsNone(scope.preview_scope(operation, self.policy, ReadScope()))
        (self.root / 'node.cmd').write_text('@echo spoofed', encoding='utf-8')
        self.assertIsNone(scope.preview_scope(operation, self.policy, self.read_scope))

    @unittest.skipUnless(os.name == 'nt', 'Windows shell scopes require the real Windows executable')
    def test_changed_tool_bytes_invalidate_remembered_scope(self):
        operation = self.operation(self.browser('shot current "first.png"'))
        before = scope.preview_scope(operation, self.policy, self.read_scope)
        self.script.write_text('// changed script', encoding='utf-8')
        after = scope.preview_scope(operation, self.policy, self.read_scope)
        self.assertNotEqual(before['packageDigest'], after['packageDigest'])

    @unittest.skipUnless(os.name == 'nt', 'Windows profile behavior')
    def test_profile_loading_cannot_replace_the_trusted_node_command(self):
        operation = self.operation(self.browser('shot current "first.png"'))
        operation['arguments']['command'] = operation['arguments']['command'].replace(' -NoProfile', '')
        profile = self.base / 'profile.ps1'
        with patch.object(scope, '_profile_paths', return_value=[str(profile)]):
            self.assertIsNotNone(scope.preview_scope(operation, self.policy, self.read_scope))
            profile.write_text('function node { Write-Output not-node }', encoding='utf-8')
            self.assertIsNone(scope.preview_scope(operation, self.policy, self.read_scope))
        with patch.object(scope, '_profile_paths', return_value=None):
            self.assertIsNone(scope.preview_scope(operation, self.policy, self.read_scope))

    @unittest.skipUnless(os.name == 'nt', 'Windows shell scopes require the real Windows executable')
    def test_native_policy_proposals_are_advisory_but_added_permissions_are_not(self):
        operation = self.operation(self.browser('shot current "first.png"'))
        original = scope.preview_scope(operation, self.policy, self.read_scope)
        proposed = {**operation, 'arguments': {**operation['arguments'],
            'proposedExecpolicyAmendment': ['powershell.exe', '-Command'],
            'proposedNetworkPolicyAmendments': [{'action': 'allow', 'host': 'example.invalid'}],
            'availableDecisions': ['accept', 'decline', 'acceptForSession']}}
        self.assertEqual(original, scope.preview_scope(proposed, self.policy, self.read_scope))
        self.assertNotEqual(access_policy.operation_digest(operation),
                            access_policy.operation_digest(proposed))
        for key in ('additionalPermissions', 'networkApprovalContext'):
            modified = {**proposed, 'arguments': {**proposed['arguments'], key: {'network': True}}}
            self.assertIsNone(scope.preview_scope(modified, self.policy, self.read_scope))


if __name__ == '__main__':
    unittest.main()
