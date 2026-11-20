"""Release prose must remain useful, attributable, and identical across installers."""
from __future__ import annotations

import copy
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import urllib.error
import zipfile
from unittest.mock import patch

import release
import release_notes as notes
import linux_signing


def example_record():
    prose = {
        'zh-CN': ('改善会话恢复。', '问题修复', '修复重新打开会话时消息未显示的问题。'),
        'en-US': ('Improves conversation recovery.', 'Bug fixes', 'Fixes messages missing after reopening a conversation.'),
        'ja-JP': ('会話の復元を改善しました。', '不具合修正', '会話を開き直すとメッセージが表示されない問題を修正しました。'),
        'ko-KR': ('대화 복원을 개선했습니다.', '버그 수정', '대화를 다시 열 때 메시지가 표시되지 않는 문제를 수정했습니다.'),
    }
    return {'schema': 1, 'version': '1.2.3', 'sourceCommit': 'a' * 40,
            'previousTag': 'v1.2.2', 'previousCommit': 'b' * 40,
            'runId': '123', 'repository': 'example/project', 'channel': 'stable',
            'commits': ['a' * 40, 'c' * 40],
            'locales': {language: {'summary': summary, 'sections': [
                {'id': 'fixes', 'title': title, 'items': [{'id': 'restore-chat', 'text': text}]}]}
                for language, (summary, title, text) in prose.items()},
            'sources': [{'sectionId': 'fixes', 'itemId': 'restore-chat', 'commits': ['a' * 40]}],
            'omitted': [{'commit': 'c' * 40, 'reason': 'maintenance'}]}


def context():
    return {'schema': 1, 'component': 'client', 'version': '1.2.3', 'repository': 'example/project',
            'commit': 'a' * 40, 'runId': '123', 'tag': 'v1.2.3'}


class NotesTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.ctx = context()
        self.record = example_record()
        self.logged = io.StringIO()
        self.enterContext(redirect_stdout(self.logged))
        self.enterContext(patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(self.root / 'summary.md')}))

    def save(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    def test_valid_notes_have_identical_localized_structure_and_markdown(self):
        self.assertEqual(notes.validate(self.record, self.ctx), self.record)
        output = notes.markdown(self.record)
        self.assertIn('### Bug fixes\n\n- Fixes messages', output)
        self.assertNotIn('改善', output)
        self.assertIn('问题修复', notes.markdown(self.record, 'zh-CN'))

    def test_missing_language_or_changed_translation_structure_is_rejected(self):
        del self.record['locales']['ko-KR']
        with self.assertRaises(ValueError):
            notes.validate(self.record)
        self.record = example_record()
        self.record['locales']['ja-JP']['sections'][0]['items'][0]['id'] = 'different'
        with self.assertRaisesRegex(ValueError, 'structure'):
            notes.validate(self.record)

    def test_unattributed_unknown_and_uncovered_commits_are_rejected(self):
        cases = []
        changed = example_record(); changed['sources'] = []; cases.append(changed)
        changed = example_record(); changed['sources'][0]['commits'] = ['f' * 40]; cases.append(changed)
        changed = example_record(); changed['omitted'] = []; cases.append(changed)
        changed = example_record(); changed['omitted'][0]['commit'] = 'a' * 40; cases.append(changed)
        for changed in cases:
            with self.subTest(changed=changed['sources']), self.assertRaises(ValueError):
                notes.validate(changed)

    def test_other_candidate_or_repository_cannot_reuse_notes(self):
        for key, value in [('version', '1.2.4'), ('sourceCommit', 'd' * 40),
                           ('runId', '124'), ('repository', 'someone/else')]:
            changed = copy.deepcopy(self.record); changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                notes.validate(changed, self.ctx)

    def test_links_html_todos_and_candidate_metadata_are_not_prose(self):
        for text in ['See https://example.test/changes', '[Changes](relative/path)',
                     '<b>Changes</b>', 'TODO: describe changes',
                     'Candidate: example/project / run 123 / abc']:
            changed = copy.deepcopy(self.record)
            changed['locales']['en-US']['sections'][0]['items'][0]['text'] = text
            with self.subTest(text=text), self.assertRaises(ValueError):
                notes.validate(changed)

    def test_generic_known_issues_placeholders_are_rejected_in_every_language(self):
        placeholders = {'zh-CN': '修复了已知问题。', 'en-US': 'Fixed known issues.',
                        'ja-JP': '既知の問題を修正しました。', 'ko-KR': '알려진 문제를 수정했습니다.'}
        for language, text in placeholders.items():
            changed = copy.deepcopy(self.record)
            changed['locales'][language]['sections'][0]['items'][0]['text'] = text
            with self.subTest(language=language), self.assertRaises(ValueError):
                notes.validate(changed)

    def test_duplicate_notes_and_empty_sections_are_rejected(self):
        self.record['locales']['en-US']['sections'][0]['items'].append({
            'id': 'duplicate', 'text': self.record['locales']['en-US']['sections'][0]['items'][0]['text']})
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            notes.validate(self.record)
        self.record = example_record()
        self.record['locales']['en-US']['sections'] = []
        with self.assertRaises(ValueError):
            notes.validate(self.record)

    def test_bundle_preserves_history_and_replaces_current_version_once(self):
        file = self.root / notes.NAME
        self.save(file, self.record)
        old = {'version': '1.2.2', 'notes': ['Earlier release'], 'status': 'released'}
        history_file = self.root / 'client/main/release-history.json'
        self.save(history_file, {'schema': 1, 'releases': [
            {'version': '1.2.3', 'notes': ['stale']}, old]})
        digest = notes.bundle(self.ctx, file, self.root)
        history = json.loads(history_file.read_text())
        self.assertEqual(digest, hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(history['releases'][0]['locales'], self.record['locales'])
        self.assertEqual(history['releases'][1:], [old])
        notes.bundle(self.ctx, file, self.root)
        self.assertEqual(json.loads(history_file.read_text()), history)

    def test_existing_output_is_reused_without_reading_baseline_or_model(self):
        file = self.root / notes.NAME
        self.save(file, self.record)
        before = file.read_bytes()
        with patch.object(notes, 'git', return_value=self.ctx['commit']), \
                patch.object(notes, 'previous') as previous, \
                patch.object(notes.urllib.request, 'build_opener') as network:
            result = notes.generate(self.ctx, file, self.root)
        self.assertEqual(result, self.record)
        self.assertEqual(file.read_bytes(), before)
        previous.assert_not_called(); network.assert_not_called()
        self.record['runId'] = 'different'
        self.save(file, self.record)
        with patch.object(notes, 'git', return_value=self.ctx['commit']), self.assertRaises(ValueError):
            notes.generate(self.ctx, file, self.root)

    def test_reviewed_notes_allow_only_notes_file_changes_to_be_omitted_automatically(self):
        reviewed = self.root / 'docs/releases/1.2.3.json'
        self.save(reviewed, self.record)
        changes = [{'commit': sha, 'message': 'Fixture title\nLong body that must not be sent', 'files': ['client/example.js']}
                   for sha in self.record['commits']]
        changes.append({'commit': 'd' * 40, 'message': 'Add notes', 'files': ['docs/releases/1.2.3.json']})
        with patch.object(notes, 'git', return_value=self.ctx['commit']), \
                patch.object(notes, 'previous', return_value=('v1.2.2', 'b' * 40)), \
                patch.object(notes, 'evidence', return_value=changes):
            result = notes.generate(self.ctx, self.root / notes.NAME, self.root)
        self.assertIn({'commit': 'd' * 40, 'reason': 'maintenance'}, result['omitted'])
        (self.root / notes.NAME).unlink()
        changes[-1]['files'].append('client/main.js')
        with patch.object(notes, 'git', return_value=self.ctx['commit']), \
                patch.object(notes, 'previous', return_value=('v1.2.2', 'b' * 40)), \
                patch.object(notes, 'evidence', return_value=changes), self.assertRaisesRegex(ValueError, 'omit code'):
            notes.generate(self.ctx, self.root / notes.NAME, self.root)

    def test_previous_uses_published_desktop_ancestor_not_source_hub_or_draft(self):
        def row(version, assets, **extra):
            return {'tag_name': 'v' + version, 'draft': False, 'prerelease': False,
                    'assets': [{'name': x} for x in assets], **extra}
        releases = [row('1.2.8', ['SoduWork-1.2.8-Setup.exe']),
                    row('1.2.7', ['SoduWork-1.2.7-Setup.exe'], draft=True),
                    row('1.2.6', ['SoduWork-1.2.6-Setup.exe'], prerelease=True),
                    row('1.2.5', ['SoduWork-1.2.5-hub-image.tar.gz']),
                    row('1.2.4', ['SoduWork-1.2.4-source.zip']),
                    row('1.2.2', ['SoduWork-1.2.2-Setup.exe'])]
        refs = {'v1.2.8^{commit}': 'd' * 40, 'v1.2.2^{commit}': 'b' * 40}
        def rev_parse(*args, **kwargs):
            self.assertEqual(args[0], 'rev-parse')
            self.assertIn(args[1], refs, 'Non-desktop or unpublished release reached Git ancestry lookup')
            return refs[args[1]]
        def ancestry(args, **kwargs):
            return subprocess.CompletedProcess(args, 1 if args[-2] == 'd' * 40 else 0)
        with patch.object(notes, 'api', return_value=releases), patch.object(notes, 'git', side_effect=rev_parse), \
                patch.object(notes.subprocess, 'run', side_effect=ancestry):
            self.assertEqual(notes.previous({**self.ctx, 'version': '1.2.9'}, self.root), ('v1.2.2', 'b' * 40))

    def test_merge_resolution_files_are_present_in_git_evidence(self):
        def git(*args):
            return subprocess.check_output(['git', *args], cwd=self.root, text=True, stderr=subprocess.STDOUT).strip()
        git('init', '-b', 'main')
        git('config', 'user.name', 'Release Fixture')
        git('config', 'user.email', 'fixture@example.test')
        (self.root / 'file.txt').write_text('base\n')
        git('add', '.'); git('commit', '-m', 'Baseline')
        baseline = git('rev-parse', 'HEAD')
        git('checkout', '-b', 'feature')
        (self.root / 'feature.txt').write_text('feature\n')
        git('add', '.'); git('commit', '-m', 'Feature work')
        git('checkout', 'main')
        (self.root / 'main.txt').write_text('main\n')
        git('add', '.'); git('commit', '-m', 'Main work')
        git('merge', '--no-ff', '--no-commit', 'feature')
        (self.root / 'resolution.txt').write_text('merge-only change\n')
        git('add', '.'); git('commit', '-m', 'Merge with a resolution change')
        head = git('rev-parse', 'HEAD')
        evidence = notes.evidence(baseline, head, self.root)
        merge = next(row for row in evidence if row['commit'] == head)
        self.assertIn('resolution.txt', merge['files'])
        self.assertIn('feature.txt', merge['files'])
        self.assertEqual(len(evidence), 3)

    def generate_with_fixture_evidence(self, **model_patch):
        changes = [{'commit': sha, 'message': 'Fixture title\nLong body that must not be sent', 'files': ['client/example.js']}
                   for sha in self.record['commits']]
        with patch.object(notes, 'git', return_value=self.ctx['commit']), \
                patch.object(notes, 'previous', return_value=('v1.2.2', 'b' * 40)), \
                patch.object(notes, 'evidence', return_value=changes), \
                patch.object(notes, 'model_notes', **model_patch):
            return notes.generate(self.ctx, self.root / notes.NAME, self.root)

    def assert_blank_record(self, record):
        self.assertEqual(record['status'], 'unavailable')
        self.assertEqual(record['locales'], {})
        self.assertEqual(record['sources'], [])
        self.assertEqual(record['omitted'], [])
        self.assertEqual(record['commits'], self.record['commits'])
        self.assertEqual(notes.markdown(record), '')
        self.assertEqual(notes.validate(record, self.ctx), record)
        self.assertNotIn('Failed', json.dumps(record))
        self.assertNotIn('Candidate:', json.dumps(record))

    def test_model_unavailable_timeout_or_rejection_writes_blank_artifact(self):
        for failure in [TimeoutError('private timeout diagnostic'), ValueError('model configuration missing'),
                        RuntimeError('provider failure')]:
            with self.subTest(failure=type(failure).__name__):
                result = self.generate_with_fixture_evidence(side_effect=failure)
                self.assert_blank_record(result)
                (self.root / notes.NAME).unlink()

    def test_invalid_model_content_writes_blank_instead_of_generic_prose(self):
        bad = copy.deepcopy(self.record)
        bad['locales']['en-US']['summary'] = 'Candidate: example/project / run 123 / abc'
        result = self.generate_with_fixture_evidence(return_value=bad)
        self.assert_blank_record(result)

    def test_model_json_missing_locales_also_leaves_notes_blank(self):
        result = self.generate_with_fixture_evidence(return_value={'sources': [], 'omitted': []})
        self.assert_blank_record(result)

    def test_unavailable_bundle_preserves_history_bytes_and_candidate_still_validates(self):
        self.record.update(status='unavailable', locales={}, sources=[], omitted=[])
        file = self.root / notes.NAME
        self.save(file, self.record)
        history_file = self.root / 'client/main/release-history.json'
        self.save(history_file, {'schema': 1, 'releases': [{'version': '1.2.2', 'notes': ['Earlier release']}]})
        before = history_file.read_bytes()
        digest = notes.bundle(self.ctx, file, self.root)
        self.assertEqual(digest, hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(history_file.read_bytes(), before)
        self.test_client_candidate_rejects_installer_notes_digest_mismatch()

    def test_unavailable_status_cannot_smuggle_prose_or_change_candidate_identity(self):
        self.record.update(status='unavailable', locales={}, sources=[], omitted=[])
        notes.validate(self.record, self.ctx)
        for updates in [{'locales': {'en-US': {'summary': 'unverified'}}}, {'sources': [{}]},
                        {'omitted': [{}]}, {'runId': '999'}]:
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                notes.validate({**self.record, **updates}, self.ctx)

    def test_invalid_reviewed_notes_still_fail_without_model_fallback(self):
        reviewed = copy.deepcopy(self.record)
        reviewed['locales']['en-US']['summary'] = 'Fixed known issues.'
        self.save(self.root / 'docs/releases/1.2.3.json', reviewed)
        with self.assertRaises(ValueError):
            self.generate_with_fixture_evidence(side_effect=AssertionError('Must not call model'))
        self.assertFalse((self.root / notes.NAME).exists())

    def test_model_compact_ids_expand_to_exact_commit_evidence(self):
        result = {key: copy.deepcopy(self.record[key]) for key in ['locales', 'sources']}
        result['sources'][0]['commits'] = ['c1']
        response = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(result)}}]}
        class Response(io.BytesIO):
            pass
        opener = unittest.mock.Mock()
        opener.open.return_value = Response(json.dumps(response).encode())
        changes = [{'commit': sha, 'message': 'Fixture title\nLong body that must not be sent', 'files': ['client/example.js']}
                   for sha in self.record['commits']]
        with patch.dict(os.environ, {'RELEASE_NOTES_API_KEY': 'fixture-model-key',
                                     'RELEASE_NOTES_MODEL': 'fixture-model'}, clear=True), \
                patch.object(notes.urllib.request, 'build_opener', return_value=opener):
            generated = notes.model_notes(self.ctx, 'v1.2.2', changes)
        self.assertEqual(generated['sources'], self.record['sources'])
        self.assertEqual(generated['omitted'], [{'commit': 'c' * 40, 'reason': 'not-highlighted'}])
        request = opener.open.call_args.args[0]
        sent = json.loads(request.data)
        evidence = json.loads(sent['messages'][1]['content'])
        self.assertEqual([c['commit'] for c in evidence['commits']], ['c1', 'c2'])
        self.assertEqual(sent['max_tokens'], 32768)
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 300)
        self.assertTrue(all(set(c) == {'commit', 'title'} for c in evidence['commits']))
        self.assertTrue(all(c['title'] == 'Fixture title' for c in evidence['commits']))
        self.assertNotIn('Long body', sent['messages'][1]['content'])
        self.assertNotIn('client/example.js', sent['messages'][1]['content'])

    def test_model_request_uses_configured_limits_and_empty_defaults(self):
        result = {key: copy.deepcopy(self.record[key]) for key in ['locales', 'sources']}
        result['sources'][0]['commits'] = ['c1']
        response = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(result)}}]}
        changes = [{'commit': sha, 'message': 'Fixture title'} for sha in self.record['commits']]
        for timeout, budget, expected_timeout, expected_budget in [
                ('', '', 300, 32768), ('  ', '  ', 300, 32768),
                (' 120 ', ' 8192 ', 120, 8192), ('600', '131072', 600, 131072), ('1', '1', 1, 1)]:
            with self.subTest(timeout=timeout, budget=budget):
                opener = unittest.mock.Mock()
                opener.open.return_value = io.BytesIO(json.dumps(response).encode())
                env = {'RELEASE_NOTES_API_KEY': 'fixture-model-key', 'RELEASE_NOTES_MODEL': 'fixture-model',
                       'RELEASE_NOTES_API_URL': 'https://model.example.test/v1/chat/completions',
                       'RELEASE_NOTES_API_KEY_SECRET': 'MODEL_TEST_KEY',
                       'RELEASE_NOTES_TIMEOUT_SECONDS': timeout, 'RELEASE_NOTES_MAX_TOKENS': budget}
                with patch.dict(os.environ, env, clear=True), \
                        patch.object(notes.urllib.request, 'build_opener', return_value=opener):
                    generated = notes.model_notes(self.ctx, 'v1.2.2', changes)
                self.assertEqual(generated['sources'], self.record['sources'])
                request = opener.open.call_args.args[0]
                self.assertEqual(request.full_url, env['RELEASE_NOTES_API_URL'])
                self.assertEqual(json.loads(request.data)['max_tokens'], expected_budget)
                self.assertNotIn('provider', json.loads(request.data))
                self.assertEqual(opener.open.call_args.kwargs['timeout'], expected_timeout)

    def test_invalid_model_configuration_leaves_notes_blank_without_network(self):
        cases = [{name: value} for name, maximum in [('RELEASE_NOTES_TIMEOUT_SECONDS', 600),
                                                    ('RELEASE_NOTES_MAX_TOKENS', 131072)]
                 for value in ['invalid', '1.5', 'nan', '0', '-1', str(maximum + 1)]]
        cases += [{'RELEASE_NOTES_API_KEY': ''},
                  {'RELEASE_NOTES_API_KEY_SECRET': 'MODEL_TEST_KEY', 'RELEASE_NOTES_API_URL': ''}]
        for updates in cases:
            with self.subTest(updates=updates):
                env = {'RELEASE_NOTES_API_KEY': 'fixture-model-key', 'RELEASE_NOTES_MODEL': 'fixture-model',
                       'RELEASE_NOTES_API_URL': 'https://model.example.test/v1/chat/completions', **updates}
                with patch.dict(os.environ, env, clear=True), \
                        patch.object(notes.urllib.request, 'build_opener') as network:
                    result = self.generate_with_fixture_evidence(wraps=notes.model_notes)
                self.assert_blank_record(result)
                network.assert_not_called()
                (self.root / notes.NAME).unlink()

    def test_reviewed_notes_ignore_invalid_model_configuration(self):
        self.save(self.root / 'docs/releases/1.2.3.json', self.record)
        with patch.dict(os.environ, {'RELEASE_NOTES_MAX_TOKENS': 'invalid',
                                     'RELEASE_NOTES_TIMEOUT_SECONDS': '-1'}, clear=True), \
                patch.object(notes.urllib.request, 'build_opener') as network:
            result = self.generate_with_fixture_evidence(side_effect=AssertionError('Must not call model'))
        self.assertEqual(result['locales'], self.record['locales'])
        network.assert_not_called()

    def openrouter_fixture(self, rows, model='fixture/model:free', response=None):
        env = {'RELEASE_NOTES_API_KEY': 'fixture-private-key', 'RELEASE_NOTES_MODEL': model,
               'RELEASE_NOTES_API_URL': 'https://openrouter.ai/api/v1/chat/completions',
               'GITHUB_STEP_SUMMARY': str(self.root / 'summary.md')}
        opener = unittest.mock.Mock()
        catalog = io.BytesIO(json.dumps({'data': rows}).encode())
        if response is None:
            result = {key: copy.deepcopy(self.record[key]) for key in ['locales', 'sources']}
            result['sources'][0]['commits'] = ['c1']
            response = io.BytesIO(json.dumps({'choices': [{'finish_reason': 'stop',
                'message': {'content': json.dumps(result)}}]}).encode())
        opener.open.side_effect = [catalog, response]
        return env, opener

    def test_openrouter_free_alias_verification_has_no_key_and_enforces_zero_price_routing(self):
        rows = [{'id': 'fixture/model', 'canonical_slug': 'fixture/model-dated',
                 'pricing': {'prompt': '1', 'completion': '1'}},
                {'id': 'fixture/model:free', 'canonical_slug': 'fixture/model-dated',
                 'pricing': {'prompt': '0', 'completion': '0', 'request': '0', 'overrides': []}}]
        env, opener = self.openrouter_fixture(rows, model='fixture/model-dated:free')
        with patch.dict(os.environ, env, clear=True), \
                patch.object(notes.urllib.request, 'build_opener', return_value=opener):
            record = self.generate_with_fixture_evidence(wraps=notes.model_notes)
        self.assertEqual(record['locales'], self.record['locales'])
        catalog, inference = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(catalog.get_method(), 'GET')
        self.assertEqual(catalog.full_url, 'https://openrouter.ai/api/v1/models')
        self.assertIsNone(catalog.get_header('Authorization'))
        self.assertEqual(inference.get_method(), 'POST')
        body = json.loads(inference.data)
        self.assertEqual(body['provider']['max_price'], {'prompt': 0, 'completion': 0, 'request': 0})
        self.assertIn('release_notes_free_model_verified', self.logged.getvalue())
        self.assertIn('"status": "generated"', self.logged.getvalue())
        self.assertNotIn('::warning', self.logged.getvalue())

    def test_openrouter_missing_paid_or_unknown_prices_never_send_inference(self):
        prices = [{'prompt': '0', 'completion': '0.01'}, {'prompt': '0'},
                  {'prompt': '0', 'completion': '0', 'request': '1e-1000'},
                  {'prompt': 'NaN', 'completion': '0'}, {'prompt': '-1', 'completion': '0'},
                  {'prompt': '0', 'completion': '0', 'overrides': [{}]},
                  {'prompt': '0', 'completion': '0', 'overrides': {}},
                  {'prompt': 'Infinity', 'completion': '0'}]
        cases = [[]] + [[{'id': 'fixture/model:free', 'pricing': price}] for price in prices]
        for rows in cases:
            with self.subTest(rows=rows):
                env, opener = self.openrouter_fixture(rows)
                with patch.dict(os.environ, env, clear=True), \
                        patch.object(notes.urllib.request, 'build_opener', return_value=opener):
                    record = self.generate_with_fixture_evidence(wraps=notes.model_notes)
                self.assert_blank_record(record)
                self.assertEqual(opener.open.call_count, 1)
                self.assertEqual(opener.open.call_args.args[0].get_method(), 'GET')
                (self.root / notes.NAME).unlink()
        self.assertIn('::warning title=Release notes unavailable::', self.logged.getvalue())
        summary = (self.root / 'summary.md').read_text()
        self.assertIn('allow a replacement free model in OpenRouter', summary)
        self.assertIn('RELEASE_NOTES_MODEL', summary)

    def test_openrouter_catalog_failure_and_paid_model_leave_notes_empty(self):
        for model, failure in [('fixture/model:free', TimeoutError('fixture-private-error')),
                               ('fixture/model:free', io.BytesIO(b'not-json fixture-private-error')),
                               ('fixture/paid-model', AssertionError('No network expected'))]:
            with self.subTest(model=model, failure=type(failure).__name__):
                env, opener = self.openrouter_fixture([], model=model)
                opener.open.side_effect = [failure]
                with patch.dict(os.environ, env, clear=True), \
                        patch.object(notes.urllib.request, 'build_opener', return_value=opener):
                    record = self.generate_with_fixture_evidence(wraps=notes.model_notes)
                self.assert_blank_record(record)
                self.assertEqual(opener.open.call_count, int(model.endswith(':free')))
                (self.root / notes.NAME).unlink()
        self.assertNotIn('fixture-private-error', self.logged.getvalue())

    def test_provider_warning_is_actionable_and_does_not_log_private_response(self):
        rows = [{'id': 'fixture/model:free', 'pricing': {'prompt': '0', 'completion': '0'}}]
        for status, expected in [(403, 'access_denied'), (404, 'model_unavailable'),
                                 (429, 'upstream_rate_limited'), (503, 'provider_error')]:
            with self.subTest(status=status):
                error = urllib.error.HTTPError('https://openrouter.ai/api/v1/chat/completions', status,
                    'fixture-private-error', {}, io.BytesIO(b'temporarily rate-limited upstream fixture-private-key'))
                env, opener = self.openrouter_fixture(rows, response=error)
                with error, patch.dict(os.environ, env, clear=True), \
                        patch.object(notes.urllib.request, 'build_opener', return_value=opener):
                    record = self.generate_with_fixture_evidence(wraps=notes.model_notes)
                self.assert_blank_record(record)
                self.assertIn('"reason": "' + expected + '"', self.logged.getvalue())
                (self.root / notes.NAME).unlink()
        output = self.logged.getvalue() + (self.root / 'summary.md').read_text()
        self.assertIn('HTTP 429', output)
        self.assertIn('RELEASE_NOTES_MODEL', output)
        self.assertNotIn('fixture-private-key', output)
        self.assertNotIn('fixture-private-error', output)

    def test_model_name_logging_is_safe_and_summary_failure_does_not_block(self):
        for model in ['fixture-private-key', 'model\n::error::injected', 'https://private.example.test/path']:
            with patch.dict(os.environ, {'RELEASE_NOTES_MODEL': model,
                                         'RELEASE_NOTES_API_KEY': 'fixture-private-key'}, clear=True):
                notes.provider.log_event('started')
        self.assertNotIn('fixture-private-key', self.logged.getvalue())
        self.assertNotIn('::error::injected', self.logged.getvalue())
        self.assertNotIn('private.example.test', self.logged.getvalue())
        with patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(self.root)}, clear=True):
            notes.provider.report_result({'status': 'unavailable'}, 0, notes.provider.ModelUnavailable('configuration'))
        self.assertIn('Release notes summary unavailable', self.logged.getvalue())

    def test_daily_provider_limit_is_not_reported_as_account_free_quota(self):
        for body, expected in [(b'provider daily capacity reached', 'rate_limited'),
                               (b'free-models-per-day quota reached', 'daily_rate_limited')]:
            with urllib.error.HTTPError('https://model.example.test', 429, 'rate limit', {}, io.BytesIO(body)) as error:
                self.assertEqual(notes.provider.classify_http(error).reason, expected)

    def test_generated_notes_over_five_highlights_are_left_blank(self):
        result = {key: copy.deepcopy(self.record[key]) for key in ['locales', 'sources', 'omitted']}
        for content in result['locales'].values():
            original = content['sections'][0]['items'][0]
            content['sections'][0]['items'] = [{'id': 'fix-' + str(i), 'text': original['text'] + str(i)} for i in range(6)]
        result['sources'] = [{'sectionId': 'fixes', 'itemId': 'fix-' + str(i), 'commits': ['a' * 40]} for i in range(6)]
        self.assert_blank_record(self.generate_with_fixture_evidence(return_value=result))

    def notes_archive(self, record=None, extra=False):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr(notes.NAME, json.dumps(record or self.record, ensure_ascii=False))
            if extra:
                archive.writestr('../unexpected', 'extra')
        return stream.getvalue()

    def test_restore_reuses_original_artifact_bytes_and_id(self):
        archive = self.notes_archive()
        metadata = {'id': 456, 'name': 'release-notes', 'expired': False, 'size_in_bytes': len(archive)}
        output = self.root / 'out' / notes.NAME
        github_output = self.root / 'github-output'
        with patch.object(notes, 'api', return_value={'artifacts': [metadata]}), \
                patch.object(notes.subprocess, 'check_output', return_value=archive) as download, \
                patch.dict(os.environ, {'GITHUB_OUTPUT': str(github_output)}):
            self.assertTrue(notes.restore(self.ctx, output))
        self.assertEqual(json.loads(output.read_text()), self.record)
        self.assertIn('artifact-id=456\n', github_output.read_text())
        self.assertIn('repos/example/project/actions/artifacts/456/zip', download.call_args.args[0])

    def test_restore_without_prior_artifact_does_not_download(self):
        with patch.object(notes, 'api', return_value={'artifacts': []}), \
                patch.object(notes.subprocess, 'check_output') as download:
            self.assertFalse(notes.restore(self.ctx, self.root / notes.NAME))
        download.assert_not_called()

    def test_restore_rejects_expired_duplicate_and_oversized_artifacts(self):
        valid = {'id': 456, 'name': 'release-notes', 'expired': False, 'size_in_bytes': 123}
        for rows in [[{**valid, 'expired': True}], [valid, {**valid, 'id': 457}],
                     [{**valid, 'size_in_bytes': 2000001}]]:
            with self.subTest(rows=rows), patch.object(notes, 'api', return_value={'artifacts': rows}), \
                    patch.object(notes.subprocess, 'check_output') as download, self.assertRaises(ValueError):
                notes.restore(self.ctx, self.root / notes.NAME)
            download.assert_not_called()

    def test_restore_rejects_wrong_candidate_and_unexpected_zip_members(self):
        wrong = {**self.record, 'runId': '999'}
        for archive in [self.notes_archive(wrong), self.notes_archive(extra=True)]:
            metadata = {'id': 456, 'name': 'release-notes', 'expired': False, 'size_in_bytes': len(archive)}
            output = self.root / notes.NAME
            with patch.object(notes, 'api', return_value={'artifacts': [metadata]}), \
                    patch.object(notes.subprocess, 'check_output', return_value=archive), self.assertRaises(ValueError):
                notes.restore(self.ctx, output)
            self.assertFalse(output.exists())

    def test_client_candidate_rejects_installer_notes_digest_mismatch(self):
        candidate = self.root / 'candidate'; candidate.mkdir()
        self.save(candidate / notes.NAME, self.record)
        digest = hashlib.sha256((candidate / notes.NAME).read_bytes()).hexdigest()
        for shard in release.SHARDS['client']:
            folder = self.root / shard; folder.mkdir()
            for name in release.expected(self.ctx, shard):
                (folder / name).write_bytes(b'accepted fixture')
            checks = {'ok': True, 'releaseNotesSha256': digest}
            if shard == 'linux':
                checks['linuxSigning'] = {'schema': 1, 'primaryFingerprint': 'A' * 40,
                    'rpmEmbedded': True, 'detached': linux_signing.package_names(self.ctx['version']),
                    'publicKey': linux_signing.PUBLIC_KEY}
            release.seal(self.ctx, shard, folder, checks)
            for file in folder.iterdir():
                shutil.move(file, candidate / file.name)
        manifest = release.candidate(self.ctx, candidate)
        self.assertEqual(release.verify(self.ctx, candidate), manifest)
        (candidate / 'release-manifest.json').unlink()
        receipt_file = candidate / 'windows-receipt.json'
        receipt = json.loads(receipt_file.read_text())
        receipt['acceptance']['releaseNotesSha256'] = 'f' * 64
        self.save(receipt_file, receipt)
        with self.assertRaisesRegex(ValueError, 'different release notes'):
            release.candidate(self.ctx, candidate)


if __name__ == '__main__':
    unittest.main()
