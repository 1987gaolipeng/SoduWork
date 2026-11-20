"""Fast contract checks for isolated startup; live verification is a separate script."""
from __future__ import annotations

from argparse import Namespace
import errno
import io
import json
from contextlib import closing, nullcontext, redirect_stderr, redirect_stdout
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

from tools.dev import local_environment as build
from tools.dev import local_path_check as path_check
from tools.dev import start_local as start
from tools.dev import verify_local_start as verify
from tools.dev import verify_desktop_fixture as desktop_fixture


class DesktopClock:
    def __init__(self):
        self.now = 0
        self.sleeps = []
        self.after_sleep = None

    def monotonic(self):
        return self.now

    def sleep(self, delay):
        self.sleeps.append(delay)
        self.now += delay
        if self.after_sleep:
            self.after_sleep()


class LocalStartupTests(unittest.TestCase):
    def test_requirement_diagnostics_opt_in_reaches_only_desktop(self):
        destination = str(self.state / 'diagnostic-records')
        with patch.dict(os.environ, {'SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR': destination}), \
                patch.object(start.subprocess, 'Popen') as popen:
            env = start.runtime_environment(self.state, {'adminUser':'test','authSecret':'synthetic-test'}, 'synthetic-test', '127.0.0.1', 18991)
            self.assertNotIn('SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR', env)
            start.launch_desktop(self.state, self.state / 'application/client', env,
                                 'http://127.0.0.1:18991', io.BytesIO())
            self.assertEqual(popen.call_args.kwargs['env'].get('SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR'), destination)

    def test_linux_root_desktop_fails_before_initialization_password_or_downloads(self):
        for options in ([], ['--prepare-only'], ['--check']):
            with self.subTest(options=options), patch.object(sys, 'platform', 'linux'), \
                    patch.dict(os.environ, {'DISPLAY': ':fixture', 'WAYLAND_DISPLAY': ''}), \
                    patch.object(os, 'geteuid', return_value=0, create=True), \
                    patch.object(start, 'check_dependencies'), \
                    patch.object(start, 'initialize') as initialize, \
                    patch.object(start, 'exclusive', return_value=nullcontext()), \
                    patch.object(start, 'prepare') as prepare, \
                    patch.object(start, 'prepare_desktop') as desktop, \
                    patch.object(start, 'serve') as serve, \
                    patch.object(start, 'password_for_start') as password, \
                    patch.object(start, 'dependency_report') as report, \
                    redirect_stdout(io.StringIO()), patch('sys.stderr', io.StringIO()) as errors:
                self.assertEqual(start.main(['--desktop', '--data-dir', str(self.state), *options]), 1)
                self.assertIn('ordinary user', errors.getvalue())
                self.assertIn('without --desktop', errors.getvalue())
                for operation in (initialize, prepare, desktop, serve, password, report):
                    operation.assert_not_called()
                self.assertFalse(self.state.exists())

    def test_desktop_session_accepts_linux_users_and_does_not_query_other_platforms(self):
        with patch.object(sys, 'platform', 'linux'), \
                patch.object(os, 'geteuid', return_value=1000, create=True):
            for display in ({'DISPLAY': ':fixture', 'WAYLAND_DISPLAY': ''},
                            {'DISPLAY': '', 'WAYLAND_DISPLAY': 'wayland-fixture'}):
                with self.subTest(display=display), patch.dict(os.environ, display):
                    build.check_desktop_session()
        for platform in ('win32', 'darwin'):
            with self.subTest(platform=platform), patch.object(sys, 'platform', platform), \
                    patch.dict(os.environ, {'DISPLAY': '', 'WAYLAND_DISPLAY': ''}), \
                    patch.object(os, 'geteuid', return_value=0, create=True) as uid:
                build.check_desktop_session()
                uid.assert_not_called()

    def test_linux_root_can_check_headless_service_prerequisites(self):
        with patch.object(sys, 'platform', 'linux'), \
                patch.dict(os.environ, {'DISPLAY': '', 'WAYLAND_DISPLAY': ''}), \
                patch.object(os, 'geteuid', return_value=0, create=True), \
                patch.object(start, 'dependency_report') as report, \
                patch.object(start, 'initialize') as initialize:
            self.assertEqual(start.main(['--check', '--data-dir', str(self.state)]), 0)
        report.assert_called_once_with(desktop=False)
        initialize.assert_not_called()
        self.assertFalse(self.state.exists())

    def test_headless_desktop_fails_before_initialization_password_or_downloads(self):
        for options in ([], ['--prepare-only'], ['--check']):
            with self.subTest(options=options), patch.object(sys, 'platform', 'linux'), \
                    patch.dict(os.environ, {'DISPLAY': '', 'WAYLAND_DISPLAY': ''}), \
                    patch.object(start, 'check_dependencies'), \
                    patch.object(start, 'initialize') as initialize, \
                    patch.object(start, 'exclusive', return_value=nullcontext()), \
                    patch.object(start, 'prepare') as prepare, \
                    patch.object(start, 'prepare_desktop') as desktop, \
                    patch.object(start, 'serve') as serve, \
                    patch.object(start, 'password_for_start') as password, \
                    patch.object(start, 'dependency_report'), \
                    redirect_stdout(io.StringIO()), patch('sys.stderr', io.StringIO()) as errors:
                self.assertEqual(start.main(['--desktop', '--data-dir', str(self.state), *options]), 1)
                self.assertIn('Desktop startup requires a graphical Linux session', errors.getvalue())
                for operation in (initialize, prepare, desktop, serve, password):
                    operation.assert_not_called()
                self.assertFalse(self.state.exists())

    def test_unfinished_git_operations_block_before_touching_runtime_data(self):
        checkout = Path(self.temp.name) / 'checkout'
        metadata = checkout / '.git'
        metadata.mkdir(parents=True)
        for marker in ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']:
            with self.subTest(marker=marker):
                (metadata / marker).touch()
                with patch.object(start, 'ROOT', checkout), patch.object(start, 'initialize') as initialize, \
                        patch.object(start, 'prepare') as prepare, patch.object(start, 'check_dependencies') as dependencies, \
                        redirect_stdout(io.StringIO()), patch('sys.stderr', io.StringIO()) as errors:
                    self.assertEqual(start.main(['--prepare-only', '--desktop', '--data-dir', str(self.state)]), 1)
                self.assertIn('unfinished Git', errors.getvalue())
                initialize.assert_not_called()
                prepare.assert_not_called()
                dependencies.assert_not_called()
                self.assertFalse(self.state.exists())
                (metadata / marker).unlink()

    def test_source_checkout_guard_supports_worktrees_and_archives_without_git(self):
        checkout = Path(self.temp.name) / 'checkout'
        checkout.mkdir()
        metadata = Path(self.temp.name) / 'metadata'
        metadata.mkdir()
        (checkout / '.git').write_text('gitdir: ../metadata\n', encoding='utf-8')
        start.check_source_checkout(checkout)
        (metadata / 'rebase-merge').mkdir()
        with self.assertRaisesRegex(start.StartupError, 'unfinished Git rebase'):
            start.check_source_checkout(checkout)
        (checkout / '.git').unlink()
        start.check_source_checkout(checkout)

    def test_desktop_verifier_mocks_only_its_owned_electron_child(self):
        self.state.mkdir(parents=True)
        client = self.state / 'application/client'
        with patch.object(sys, 'platform', 'darwin'), patch.object(start.subprocess, 'Popen') as popen:
            desktop_fixture.launch_desktop_fixture(start.launch_desktop, self.state, client, {},
                                                   'http://127.0.0.1:18989', io.BytesIO())
            fixture_command = popen.call_args.args[0]
            self.assertEqual(fixture_command[1:], [str(client / 'scripts/start-client.cjs'), '--use-mock-keychain'])
            self.assertEqual(Path(popen.call_args.kwargs['env']['SODUWORK_USER_DATA']), self.state / 'desktop-profile')
            start.launch_desktop(self.state, client, {}, 'http://127.0.0.1:18989', io.BytesIO())
            self.assertEqual(popen.call_args.args[0][1:], [str(client / 'scripts/start-client.cjs')])

    def test_desktop_fixture_refuses_an_ordinary_profile(self):
        self.state.mkdir(parents=True)
        with patch.object(sys, 'platform', 'darwin'), patch.object(start, 'main') as main, \
                self.assertRaises(SystemExit):
            desktop_fixture.main(['--data-dir', str(self.state), '--desktop'])
        main.assert_not_called()

    def desktop_journal_fixture(self, entries, *, alive=True):
        journal = self.state / 'desktop-profile/diagnostics/lifecycle.jsonl'
        journal.parent.mkdir(parents=True, exist_ok=True)
        journal.write_text(''.join(json.dumps(row) + '\n' for row in entries), encoding='utf-8')
        clock = DesktopClock()
        self.enterContext(patch.object(verify, 'time', clock))
        self.enterContext(patch.object(verify, 'process_alive', return_value=alive))
        child = Namespace(launcher_log='isolated launcher fixture', poll=lambda: None)
        return journal, child, clock

    def test_desktop_restart_ignores_live_historical_ready_events(self):
        journal, child, clock = self.desktop_journal_fixture([
            {'event': 'ready', 'pid': 100, 'runId': 'older'},
            {'event': 'ready', 'pid': 200, 'runId': 'previous'},
        ])
        previous_runs = verify.desktop_run_ids(self.state)

        def append_ready():
            with journal.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps({'event': 'ready', 'pid': 300, 'runId': 'new'}) + '\n')
        clock.after_sleep = append_ready
        self.assertEqual(verify.desktop_ready(child, self.state, previous_runs=previous_runs), 300)
        self.assertEqual(len(clock.sleeps), 1, 'Historical ready entries must not satisfy a restart')

    def test_desktop_run_snapshot_includes_non_ready_runs_and_ignores_missing_ids(self):
        self.assertEqual(verify.desktop_run_ids(self.state), set())
        self.desktop_journal_fixture([
            {'event': 'ready', 'pid': 100, 'runId': 'finished'},
            {'event': 'exit', 'pid': 100, 'runId': 'finished'},
            {'event': 'start', 'pid': 100, 'runId': 'starting'},
            {'event': 'unhandled-rejection', 'pid': 200, 'runId': 'failed'},
            {'event': 'ready', 'pid': 300},
            {'event': 'ready', 'pid': 300, 'runId': ''},
            {'event': 'ready', 'pid': 300, 'runId': None},
        ])
        self.assertEqual(verify.desktop_run_ids(self.state), {'finished', 'starting', 'failed'})

    def test_desktop_restart_accepts_reused_pid_ready_before_wait_begins(self):
        journal, child, clock = self.desktop_journal_fixture([
            {'event': 'ready', 'pid': 100, 'runId': 'previous'},
        ])
        previous_runs = verify.desktop_run_ids(self.state)
        with journal.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({'event': 'ready', 'pid': 100, 'runId': 'new'}) + '\n')
        self.assertEqual(verify.desktop_ready(child, self.state, previous_runs=previous_runs), 100)
        self.assertEqual(clock.sleeps, [], 'Readiness written before polling must remain eligible')

    def test_desktop_restart_excludes_every_historical_run_sharing_the_pid(self):
        journal, child, clock = self.desktop_journal_fixture([
            {'event': 'ready', 'pid': 100, 'runId': 'older'},
            {'event': 'ready', 'pid': 100, 'runId': 'previous'},
            {'event': 'start', 'pid': 100, 'runId': 'unfinished'},
        ])
        previous_runs = verify.desktop_run_ids(self.state)

        def append_ready():
            run_id = 'unfinished' if len(clock.sleeps) == 1 else 'new'
            with journal.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps({'event': 'ready', 'pid': 100, 'runId': run_id}) + '\n')
        clock.after_sleep = append_ready
        self.assertEqual(verify.desktop_ready(child, self.state, previous_runs=previous_runs), 100)
        self.assertEqual(len(clock.sleeps), 2, 'All snapshotted runs stay historical, including late ready events')

    def test_desktop_readiness_errors_are_scoped_to_the_new_run(self):
        for event in ('uncaught-exception-monitor', 'unhandled-rejection'):
            for failed_run in ('previous', 'new'):
                with self.subTest(event=event, failed_run=failed_run):
                    _, child, clock = self.desktop_journal_fixture([
                        {'event': 'ready', 'pid': 100, 'runId': 'previous'},
                        {'event': event, 'pid': 100, 'runId': failed_run},
                        {'event': 'ready', 'pid': 100, 'runId': 'new'},
                    ])
                    if failed_run == 'new':
                        with self.assertRaisesRegex(AssertionError, 'Desktop initialization failed'):
                            verify.desktop_ready(child, self.state, previous_runs={'previous'})
                    else:
                        self.assertEqual(verify.desktop_ready(child, self.state, previous_runs={'previous'}), 100)
                    self.assertEqual(clock.sleeps, [])

    def test_desktop_readiness_rejects_dead_pids_and_missing_run_ids(self):
        cases = [(False, {'runId': 'new'}), (True, {}), (True, {'runId': ''}), (True, {'runId': None})]
        for alive, fields in cases:
            with self.subTest(alive=alive, fields=fields):
                _, child, clock = self.desktop_journal_fixture([{'event': 'ready', 'pid': 100, **fields}], alive=alive)
                with self.assertRaisesRegex(AssertionError, 'Electron did not become ready'):
                    verify.desktop_ready(child, self.state)
                self.assertGreaterEqual(clock.now, 45)

    def test_node_version_matches_runtime_dependency_minimum(self):
        with patch.object(build.shutil, 'which', side_effect=lambda name: name), patch.object(build, '_check_npm_version'):
            for version in ['v22.18.0', 'v20.20.0', 'v22.18.9-rc.1', 'v26.0', 'v26.0.0-invalid suffix']:
                with self.subTest(version=version), patch.object(build.subprocess, 'check_output', return_value=version), \
                        self.assertRaisesRegex(build.StartupError, '22.19'):
                    build.check_dependencies()
            for version in ['v22.19.0', 'v24.18.0', 'v26.0.0-nightly.20250611d1045ea0f2',
                            'v24.0.0-rc.1', 'v24.0.0+build.42']:
                with self.subTest(version=version), patch.object(build.subprocess, 'check_output', return_value=version):
                    self.assertEqual(len(build.check_dependencies()), 2)

    def npm_fixture(self, body):
        script = Path(self.temp.name) / 'npm'
        script.write_text("#!/usr/bin/env python3\nimport sys\n"
                          "assert sys.argv[1:] == ['--version']\n" + body, encoding='utf-8')
        if os.name == 'nt':
            wrapper = script.with_suffix('.cmd')
            wrapper.write_text('@"%NPM_TEST_PYTHON%" "%~dp0npm" %*\n', encoding='ascii')
            self.enterContext(patch.dict(os.environ, NPM_TEST_PYTHON=sys.executable))
            return str(wrapper)
        script.chmod(0o755)
        return str(script)

    def test_npm_preflight_requires_success_and_a_version_line(self):
        cases = [(b'', 0, False), (b'npm unavailable', 0, False), (b'10.9.3', 1, False),
                 (b'error 10.9.3', 0, False), (b'\xe4\xb8\xad\r\n10.9.3\r\n', 0, True),
                 (b'1.0.0-rc.1+build.42', 0, True)]
        for output, code, valid in cases:
            npm = self.npm_fixture(f'sys.stdout.buffer.write({output!r})\nsys.exit({code})\n')
            with self.subTest(output=output, code=code), \
                    patch.object(build.shutil, 'which', side_effect=lambda name: 'node' if name == 'node' else npm), \
                    patch.object(build.subprocess, 'check_output', return_value='v22.19.0'):
                if valid:
                    self.assertEqual(build.check_dependencies(), ('node', npm))
                else:
                    with self.assertRaisesRegex(build.StartupError, 'npm --version'):
                        build.check_dependencies()

    def test_npm_probe_times_out_with_a_child_holding_stdout(self):
        npm = self.npm_fixture("import subprocess\n"
                               "subprocess.run([sys.executable, '-c', 'import time; time.sleep(12)'])\n")
        started = time.monotonic()
        with patch.object(build, 'NPM_PROBE_TIMEOUT', 1), self.assertRaisesRegex(build.StartupError, 'timed out'):
            build._check_npm_version(npm)
        self.assertLess(time.monotonic() - started, 8)

    def test_dependency_report_prints_the_version_from_a_single_node_probe(self):
        with patch.object(build.shutil, 'which', side_effect=lambda name: name), \
                patch.object(build, '_check_npm_version') as npm_probe, \
                patch.object(build.subprocess, 'check_output', return_value='v24.0.0+build.42\n') as probe, \
                redirect_stdout(io.StringIO()) as output:
            build.dependency_report()

        commands = [call.args[0] for call in probe.call_args_list]
        self.assertEqual(commands.count(['node', '--version']), 1)
        npm_probe.assert_called_once_with('npm.cmd' if os.name == 'nt' else 'npm')
        self.assertIn('Node.js: v24.0.0+build.42', output.getvalue().splitlines())

    def test_unexecutable_node_reports_friendly_error(self):
        for failure in (OSError('Permission denied'), OSError('Exec format error')):
            with self.subTest(failure=str(failure)), \
                    patch.object(build.shutil, 'which', side_effect=lambda name: name), \
                    patch.object(build.subprocess, 'check_output', side_effect=failure), \
                    self.assertRaisesRegex(build.StartupError, '22.19'):
                build.check_dependencies()

    def setUp(self):
        # Desktop fixtures represent an ordinary login, even in root-run CI.
        uid = patch.object(os, 'geteuid', return_value=1000, create=True)
        uid.start()
        self.addCleanup(uid.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-start-unit-")
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "service"

    def test_live_verifier_uses_default_caches_without_changing_parent_settings(self):
        choices = {'npm_config_cache': '/operator/npm', 'PIP_CACHE_DIR': '/operator/pip',
                   'electron_config_cache': '/operator/electron', 'PIP_NO_CACHE_DIR': '1'}
        with patch.dict(os.environ, choices), patch.object(verify.subprocess, 'Popen') as popen:
            before = dict(os.environ)
            _, output = verify.start(self.state, 18989)
            output.close()
            self.assertTrue(dict(os.environ) == before, 'Verifier changed the parent environment')
            child_keys = {key.lower() for key in popen.call_args.kwargs['env']}
        self.assertFalse(child_keys & {key.lower() for key in choices})

    def test_live_cache_acceptance_requires_payloads_and_the_temporary_directory(self):
        for name in ('npm', 'pip'):
            cache = self.state / 'cache' / name
            cache.mkdir(parents=True)
            (cache / 'fixture').write_bytes(b'fixture')
        with self.assertRaisesRegex(AssertionError, 'temporary directory'):
            verify.install_cache_sizes(self.state, desktop=False)
        (self.state / 'cache/tmp').mkdir()
        self.assertEqual(verify.install_cache_sizes(self.state, desktop=False), {'npm': 7, 'pip': 7})
        with self.assertRaisesRegex(AssertionError, 'electron install cache'):
            verify.install_cache_sizes(self.state, desktop=True)
        (self.state / 'cache/electron').mkdir()
        (self.state / 'cache/electron/archive.zip').write_bytes(b'fixture')
        self.assertEqual(verify.install_cache_sizes(self.state, desktop=True), {'npm': 7, 'pip': 7, 'electron': 7})

    def test_fresh_source_instance_uses_current_name_but_existing_data_stays(self):
        base = Path(self.temp.name) / "user-data"
        with patch.dict(os.environ, {"LOCALAPPDATA": str(base), "XDG_DATA_HOME": str(base)}):
            if sys.platform == "darwin":
                return  # Native macOS path is covered by its platform startup job.
            fresh = start.default_state()
            self.assertIn("soduwork", fresh.as_posix().lower())
            old = base / ("SoduWork/source-service" if os.name == "nt" else "soduwork/source-service")
            old.mkdir(parents=True)
            (old / "local-service.json").write_text("{}", encoding="utf-8")
            self.assertEqual(start.default_state(), old)
            fresh.mkdir(parents=True, exist_ok=True)
            marker = fresh / "local-service.json"
            marker.write_text("{}", encoding="utf-8")
            self.assertEqual(start.default_state(), fresh)
            self.assertEqual(marker.read_text(encoding="utf-8"), "{}")

    @unittest.skipIf(os.name == 'nt', 'Linux XDG paths use POSIX semantics')
    def test_linux_default_state_falls_back_for_invalid_xdg_data_home(self):
        home = Path(self.temp.name) / 'home'
        expected = home / '.local/share/soduwork/source-service'
        for value in (None, '', 'relative-data', '~/data'):
            environment = {} if value is None else {'XDG_DATA_HOME': value}
            with self.subTest(value=value), patch.dict(os.environ, environment, clear=True), \
                    patch.object(sys, 'platform', 'linux'), patch.object(Path, 'home', return_value=home):
                self.assertEqual(start.default_state(), expected)
        self.assertFalse(home.exists())

    @unittest.skipIf(os.name == 'nt', 'Linux XDG paths use POSIX semantics')
    def test_linux_default_state_preserves_absolute_xdg_data_and_existing_files(self):
        for name in ('custom-data', 'custom data with spaces'):
            base = Path(self.temp.name) / name
            expected = base / 'soduwork/source-service'
            expected.mkdir(parents=True)
            marker = expected / 'local-service.json'
            marker.write_text('{}', encoding='utf-8')
            with self.subTest(name=name), patch.dict(os.environ, {'XDG_DATA_HOME': str(base)}), \
                    patch.object(sys, 'platform', 'linux'):
                self.assertEqual(start.default_state(), expected)
            self.assertEqual(marker.read_text(encoding='utf-8'), '{}')

    @unittest.skipIf(os.name == 'nt', 'Linux XDG paths use POSIX semantics')
    def test_linux_prepare_only_uses_safe_default_with_invalid_xdg_data_home(self):
        home = Path(self.temp.name) / 'home'
        expected = (home / '.local/share/soduwork/source-service').resolve()
        for value in ('', 'relative-data'):
            with self.subTest(value=value), patch.dict(os.environ, {'XDG_DATA_HOME': value}), \
                    patch.object(sys, 'platform', 'linux'), patch.object(Path, 'home', return_value=home), \
                    patch.object(start, 'check_dependencies'), patch.object(start.signal, 'signal'), \
                    patch.object(start, 'initialize', return_value={}) as initialize, \
                    patch.object(start, 'exclusive', return_value=nullcontext()), \
                    patch.object(start, 'prepare') as prepare, redirect_stdout(io.StringIO()), \
                    patch('sys.stderr', io.StringIO()):
                self.assertEqual(start.main(['--prepare-only']), 0)
                initialize.assert_called_once_with(expected, 'admin')
                prepare.assert_called_once_with(expected, expected / 'startup.log')
        self.assertFalse(home.exists())

    def test_explicit_data_dir_overrides_invalid_platform_data_home(self):
        home = Path(self.temp.name) / 'home'
        chosen = (Path(self.temp.name) / 'chosen data').resolve()
        chosen.mkdir()
        marker = chosen / 'local-service.json'
        marker.write_text('{}', encoding='utf-8')
        for value in ('', 'relative-data'):
            with self.subTest(value=value), \
                    patch.dict(os.environ, {'XDG_DATA_HOME': value, 'LOCALAPPDATA': value}), \
                    patch.object(Path, 'home', return_value=home), \
                    patch.object(start, 'check_dependencies'), patch.object(start.signal, 'signal'), \
                    patch.object(start, 'initialize', return_value={}) as initialize, \
                    patch.object(start, 'exclusive', return_value=nullcontext()), \
                    patch.object(start, 'prepare') as prepare, redirect_stdout(io.StringIO()), \
                    patch('sys.stderr', io.StringIO()):
                self.assertEqual(start.main(['--prepare-only', '--data-dir', str(chosen)]), 0)
                initialize.assert_called_once_with(chosen, 'admin')
                prepare.assert_called_once_with(chosen, chosen / 'startup.log')
            self.assertEqual(marker.read_text(encoding='utf-8'), '{}')
        self.assertFalse(home.exists())

    @unittest.skipIf(os.name == 'nt', 'Linux XDG paths use POSIX semantics')
    def test_linux_absolute_xdg_data_home_inside_checkout_is_still_rejected(self):
        checkout = (Path(self.temp.name) / 'checkout').resolve()
        checkout.mkdir()
        base = checkout / 'xdg-data'
        with patch.dict(os.environ, {'XDG_DATA_HOME': str(base)}), \
                patch.object(sys, 'platform', 'linux'), patch.object(start, 'ROOT', checkout), \
                patch.object(start, 'check_dependencies'), patch.object(start.signal, 'signal'), \
                patch.object(start, 'initialize') as initialize, patch.object(start, 'exclusive') as exclusive, \
                patch.object(start, 'prepare') as prepare, redirect_stdout(io.StringIO()), \
                patch('sys.stderr', io.StringIO()) as errors:
            self.assertEqual(start.main(['--prepare-only']), 1)
        self.assertIn('outside the source checkout', errors.getvalue())
        initialize.assert_not_called()
        exclusive.assert_not_called()
        prepare.assert_not_called()
        self.assertFalse(base.exists())

    def test_windows_default_state_ignores_empty_or_relative_localappdata(self):
        home = Path(self.temp.name) / "home"
        expected = home / "AppData/Local/SoduWork/source-service"
        for value in ("", "relative-data", ".."):
            with patch.object(start, "os", wraps=os) as platform_os, \
                    patch.object(Path, "home", return_value=home), \
                    patch.dict(os.environ, {"LOCALAPPDATA": value}):
                platform_os.name = "nt"
                resolved = start.default_state()
            self.assertEqual(resolved, expected, f"LOCALAPPDATA={value!r} 时解析结果不正确")
            self.assertTrue(resolved.is_absolute(), f"LOCALAPPDATA={value!r} 时得到相对路径")

    def test_windows_default_state_keeps_an_absolute_localappdata(self):
        chosen = Path(self.temp.name) / "chosen"
        with patch.object(start, "os", wraps=os) as platform_os, \
                patch.dict(os.environ, {"LOCALAPPDATA": str(chosen)}):
            platform_os.name = "nt"
            self.assertEqual(start.default_state(), chosen / "SoduWork/source-service")

    def test_macos_default_desktop_profile_is_outside_installed_client(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        installed = app_data / 'SoduWork'
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'), \
                patch.object(start, 'os', wraps=os) as platform_os:
            platform_os.name = 'posix'
            state = start.default_state()
            self.assertEqual(state, installed / 'source-service')
            with patch.object(start.subprocess, 'Popen') as popen:
                start.launch_desktop(state, state / 'application/client', {}, 'http://127.0.0.1:18989', io.BytesIO())
            profile = Path(popen.call_args.kwargs['env']['SODUWORK_USER_DATA'])
            self.assertFalse(profile.resolve().is_relative_to(installed.resolve()))
            self.assertTrue((profile / 'hub-endpoint.json').is_file())
            self.assertFalse((state / 'desktop-profile').exists())
            self.assertEqual(start.desktop_profile(state), profile)
            self.assertEqual(start.desktop_profile(self.state), self.state / 'desktop-profile')

    def directory_link(self, target: Path, link: Path) -> None:
        if os.name == 'nt':
            # Junctions exercise real path resolution without symbolic-link privileges.
            subprocess.run(['node', '-e',
                            "require('node:fs').symlinkSync(process.argv[1], process.argv[2], 'junction')",
                            str(target), str(link)], check=True, capture_output=True)
        else:
            link.symlink_to(target, target_is_directory=True)

    def test_macos_custom_desktop_profiles_are_stable_and_keep_hub_data_in_place(self):
        import json
        for case, name in enumerate(('SoduWork', 'soduwork')):
            with self.subTest(installed_name=name):
                home = Path(self.temp.name) / ('home-' + str(case))
                app_data = home / 'Library/Application Support'
                installed = app_data / name
                states = [installed / 'skill-install-verification', installed / 'another-instance']
                profiles = []
                for index, state in enumerate(states):
                    state.mkdir(parents=True)
                    marker = state / 'soduwork.db'
                    marker.write_bytes(b'Existing Hub data must stay in place')
                    endpoint = 'http://127.0.0.1:' + str(18990 + index)
                    with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
                        profile = start.desktop_profile(state)
                        self.assertFalse(profile.resolve().is_relative_to(installed.resolve()))
                        self.assertTrue(profile.resolve().is_relative_to((app_data / 'SoduWork Development').resolve()))
                        self.assertEqual(start.desktop_profile(state), profile)
                        self.assertEqual(start.desktop_profile(state / 'unused/..'), profile)
                        with patch.object(start.subprocess, 'Popen') as popen:
                            start.launch_desktop(state, state / 'application/client', {}, endpoint, io.BytesIO())
                        self.assertEqual(Path(popen.call_args.kwargs['env']['SODUWORK_USER_DATA']), profile)
                    profiles.append(profile)
                    self.assertEqual(marker.read_bytes(), b'Existing Hub data must stay in place')
                    self.assertFalse((state / 'desktop-profile').exists())
                    self.assertEqual(json.loads((profile / 'hub-endpoint.json').read_text()), {'hub': endpoint})
                    self.assertEqual(json.loads((profile / 'chat-config.json').read_text()),
                                     {'workDir': str(state / 'workspaces')})
                self.assertNotEqual(profiles[0], profiles[1])
                self.assertEqual(json.loads((profiles[0] / 'hub-endpoint.json').read_text()),
                                 {'hub': 'http://127.0.0.1:18990'})

    def test_macos_profile_path_aliases_preserve_default_compatibility_and_custom_identity(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        default = app_data / 'SoduWork/source-service'
        custom = app_data / 'SoduWork/custom-service'
        default.mkdir(parents=True)
        custom.mkdir()
        default_alias, custom_alias = home / 'default-alias', home / 'custom-alias'
        self.directory_link(default, default_alias)
        self.directory_link(custom, custom_alias)
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
            expected = app_data / 'SoduWork Development/source-service-desktop'
            self.assertEqual(start.desktop_profile(default), expected)
            self.assertEqual(start.desktop_profile(default_alias), expected)
            custom_profile = start.desktop_profile(custom)
            self.assertNotEqual(custom_profile, expected)
            self.assertEqual(start.desktop_profile(custom_alias), custom_profile)

    def test_desktop_profile_redirect_does_not_match_sibling_names_or_other_platforms(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        with patch.object(Path, 'home', return_value=home):
            with patch.object(sys, 'platform', 'darwin'):
                for state in (self.state, app_data / 'SoduWork-other/test',
                              app_data / 'SoduWork Development/test'):
                    self.assertEqual(start.desktop_profile(state), state / 'desktop-profile')
            for platform in ('win32', 'linux'):
                with self.subTest(platform=platform), patch.object(sys, 'platform', platform):
                    for state in (self.state, app_data / 'SoduWork/source-service',
                                  app_data / 'SoduWork/custom-service'):
                        self.assertEqual(start.desktop_profile(state), state / 'desktop-profile')

    def test_macos_desktop_isolates_input_links_and_rejects_unsafe_output_links_before_writing(self):
        for location in ('external-profile', 'development-root'):
            with self.subTest(location=location):
                home = Path(self.temp.name) / location
                app_data = home / 'Library/Application Support'
                installed = app_data / 'SoduWork'
                installed.mkdir(parents=True)
                endpoint = installed / 'hub-endpoint.json'
                endpoint.write_text('installed endpoint must not change', encoding='utf-8')
                credential = installed / 'device-auth.json'
                credential.write_text('installed credential fixture', encoding='utf-8')
                if location == 'external-profile':
                    state = home / 'external-service'
                    state.mkdir()
                    self.directory_link(installed, state / 'desktop-profile')
                else:
                    state = installed / 'source-service'
                    state.mkdir()
                    self.directory_link(installed, app_data / 'SoduWork Development')
                before = sorted(str(p.relative_to(home)) for p in home.rglob('*'))
                with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'), \
                        patch.object(start.subprocess, 'Popen') as popen:
                    if location == 'external-profile':
                        profile = start.desktop_profile(state)
                        self.assertTrue(profile.is_relative_to(app_data / 'SoduWork Development'))
                        start.launch_desktop(state, state / 'application/client', {},
                                             'http://127.0.0.1:18990', io.BytesIO())
                        self.assertEqual(Path(popen.call_args.kwargs['env']['SODUWORK_USER_DATA']), profile)
                        self.assertEqual((state / 'desktop-profile').resolve(), installed.resolve())
                        self.assertEqual({p.name for p in installed.iterdir()},
                                         {'hub-endpoint.json', 'device-auth.json'})
                    else:
                        with self.assertRaises(start.StartupError):
                            start.launch_desktop(state, state / 'application/client', {},
                                                 'http://127.0.0.1:18990', io.BytesIO())
                        popen.assert_not_called()
                        self.assertEqual(sorted(str(p.relative_to(home)) for p in home.rglob('*')), before)
                self.assertEqual(endpoint.read_text(), 'installed endpoint must not change')
                self.assertEqual(credential.read_text(), 'installed credential fixture')

    def test_macos_custom_nested_states_have_stable_independent_desktop_profiles(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        installed = app_data / 'SoduWork'
        installed.mkdir(parents=True)
        sentinel = installed / 'device-auth.json'
        sentinel.write_text('installed-private-fixture', encoding='utf-8')
        state = installed / 'local-model-verify'
        old_profile = state / 'desktop-profile'
        old_profile.mkdir(parents=True)
        old_endpoint = old_profile / 'hub-endpoint.json'
        old_endpoint.write_text('previous-source-fixture', encoding='utf-8')
        database = state / 'soduwork.db'
        database.write_bytes(b'existing-source-data')
        alias = home / 'state-alias'
        self.directory_link(state, alias)
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
            first = start.desktop_profile(state)
            second = start.desktop_profile(installed / 'other-verification')
            self.assertNotEqual(first, second)
            self.assertEqual(start.desktop_profile(alias), first)
            self.assertEqual(start.desktop_profile(state), first)
            self.assertTrue(first.is_relative_to(app_data / 'SoduWork Development'))
            self.assertFalse(first.resolve().is_relative_to(installed.resolve()))
            with patch.object(start.subprocess, 'Popen') as popen:
                start.launch_desktop(state, state / 'application/client', {},
                                     'http://127.0.0.1:18990', io.BytesIO())
            self.assertEqual(Path(popen.call_args.kwargs['env']['SODUWORK_USER_DATA']), first)
            self.assertTrue((first / 'hub-endpoint.json').is_file())
        self.assertEqual(sentinel.read_text(encoding='utf-8'), 'installed-private-fixture')
        self.assertEqual(old_endpoint.read_text(encoding='utf-8'), 'previous-source-fixture')
        self.assertEqual(database.read_bytes(), b'existing-source-data')

    def test_macos_reserved_names_are_case_insensitive_without_merging_distinct_state_paths(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
            for name in ['SoduWork', 'soduwork', 'SODUWORK']:
                profile = start.desktop_profile(app_data / name / 'custom')
                self.assertTrue(profile.is_relative_to(app_data / 'SoduWork Development'))
            a = start.desktop_profile(app_data / 'SoduWork/CaseState')
            b = start.desktop_profile(app_data / 'SoduWork/casestate')
            self.assertNotEqual(a, b)
            outside = app_data / 'SoduWork Other/custom'
            self.assertEqual(start.desktop_profile(outside), outside / 'desktop-profile')

    def test_macos_default_state_alias_retains_the_existing_desktop_profile(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        state = app_data / 'SoduWork/source-service'
        state.mkdir(parents=True)
        alias = home / 'default-alias'
        self.directory_link(state, alias)
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
            expected = app_data / 'SoduWork Development/source-service-desktop'
            self.assertEqual(start.desktop_profile(alias), expected)
            case_alias = app_data / 'soduwork/SOURCE-SERVICE'
            if case_alias.exists() and case_alias.samefile(state):
                self.assertEqual(start.desktop_profile(case_alias), expected)

    def test_macos_rejects_development_links_into_installed_data_before_any_write(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        installed = app_data / 'SoduWork'
        installed.mkdir(parents=True)
        sentinel = installed / 'hub-endpoint.json'
        sentinel.write_text('installed-endpoint-fixture', encoding='utf-8')
        self.directory_link(installed, app_data / 'SoduWork Development')
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'), \
                patch.object(start.subprocess, 'Popen') as popen:
            for state in [installed / 'source-service', installed / 'local-model-verify']:
                with self.subTest(state=state), self.assertRaisesRegex(start.StartupError, 'inside installed client data'):
                    start.launch_desktop(state, state / 'application/client', {},
                                         'http://127.0.0.1:18990', io.BytesIO())
            popen.assert_not_called()
        self.assertEqual(sentinel.read_text(encoding='utf-8'), 'installed-endpoint-fixture')
        self.assertEqual({p.name for p in installed.iterdir()}, {'hub-endpoint.json'})

    def test_macos_reserved_states_keep_mapping_when_old_profiles_link_outside(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
            for name in ['source-service', 'local-model-verify']:
                state = app_data / 'SoduWork' / name
                state.mkdir(parents=True)
                expected = start.desktop_profile(state)
                external = home / ('old-profile-' + name)
                external.mkdir()
                sentinel = external / 'chat-config.json'
                sentinel.write_text('previous-profile-fixture', encoding='utf-8')
                link = state / 'desktop-profile'
                self.directory_link(external, link)
                with self.subTest(state=name):
                    self.assertEqual(start.desktop_profile(state), expected)
                    with patch.object(start.subprocess, 'Popen'):
                        start.launch_desktop(state, state / 'application/client', {},
                                             'http://127.0.0.1:18990', io.BytesIO())
                    self.assertTrue(link.is_symlink() or link.is_junction())
                    self.assertEqual(link.resolve(), external.resolve())
                    self.assertEqual(sentinel.read_text(encoding='utf-8'), 'previous-profile-fixture')
                    self.assertEqual({p.name for p in external.iterdir()}, {'chat-config.json'})

    def test_macos_custom_profiles_preserve_upstream_identity_and_existing_nested_profiles(self):
        import hashlib
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        state = app_data / 'SoduWork/custom-service'
        namespace = hashlib.sha256(os.fsencode(state.resolve())).hexdigest()[:20]
        development = app_data / 'SoduWork Development'
        canonical = development / ('source-service-desktop-' + namespace)
        legacy = development / 'source-service-desktops' / namespace
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
            self.assertEqual(start.desktop_profile(state), canonical)
            self.assertFalse(development.exists(), 'selection must not create profiles')
            legacy.mkdir(parents=True)
            marker = legacy / 'device-auth.json'
            marker.write_text('existing-development-identity', encoding='utf-8')
            self.assertEqual(start.desktop_profile(state), legacy)
            self.assertFalse(canonical.exists())
            canonical.mkdir()
            current = canonical / 'device-auth.json'
            current.write_text('upstream-development-identity', encoding='utf-8')
            self.assertEqual(start.desktop_profile(state), canonical)
            self.assertEqual(marker.read_text(encoding='utf-8'), 'existing-development-identity')
            self.assertEqual(current.read_text(encoding='utf-8'), 'upstream-development-identity')
            self.assertEqual({p.name for p in legacy.iterdir()}, {'device-auth.json'})
            self.assertEqual({p.name for p in canonical.iterdir()}, {'device-auth.json'})

    def test_macos_invalid_custom_profile_candidates_never_fall_back_or_write(self):
        for kind in ('canonical-file', 'canonical-dangling-link', 'canonical-installed-link',
                     'legacy-file', 'legacy-installed-link', 'legacy-external-link'):
            with self.subTest(kind=kind):
                home = Path(self.temp.name) / kind
                app_data = home / 'Library/Application Support'
                installed = app_data / 'SoduWork'
                installed.mkdir(parents=True)
                sentinel = installed / 'device-auth.json'
                sentinel.write_text('installed-identity', encoding='utf-8')
                state = installed / 'custom-service'
                with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
                    canonical = start.desktop_profile(state)
                    legacy = canonical.parent / 'source-service-desktops' / canonical.name.removeprefix('source-service-desktop-')
                    candidate = canonical if kind.startswith('canonical-') else legacy
                    candidate.parent.mkdir(parents=True, exist_ok=True)
                    if kind.startswith('canonical-'):
                        legacy.mkdir(parents=True)
                    if kind.endswith('-file'):
                        candidate.write_text('do-not-overwrite', encoding='utf-8')
                    else:
                        target = installed if kind.endswith('installed-link') else home / 'external-target'
                        target.mkdir(exist_ok=True)
                        self.directory_link(target, candidate)
                        if kind.endswith('dangling-link'):
                            target.rmdir()
                    before = sorted(str(p.relative_to(home)) for p in home.rglob('*'))
                    # Windows fixture links require a real subprocess; mock only the desktop launch.
                    with patch.object(start.subprocess, 'Popen') as popen:
                        with self.assertRaisesRegex(start.StartupError, 'existing data was not changed'):
                            start.launch_desktop(state, state / 'application/client', {},
                                                 'http://127.0.0.1:18990', io.BytesIO())
                        popen.assert_not_called()
                    self.assertEqual(sorted(str(p.relative_to(home)) for p in home.rglob('*')), before)
                    self.assertEqual(sentinel.read_text(encoding='utf-8'), 'installed-identity')

    def test_macos_existing_canonical_profile_does_not_merge_or_inspect_unused_legacy_profile(self):
        home = Path(self.temp.name)
        app_data = home / 'Library/Application Support'
        installed = app_data / 'SoduWork'
        installed.mkdir(parents=True)
        state = installed / 'custom-service'
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'):
            canonical = start.desktop_profile(state)
            canonical.mkdir(parents=True)
            legacy = canonical.parent / 'source-service-desktops' / canonical.name.removeprefix('source-service-desktop-')
            legacy.parent.mkdir()
            self.directory_link(installed, legacy)
            self.assertEqual(start.desktop_profile(state), canonical)
            self.assertEqual(legacy.resolve(), installed.resolve())
            self.assertEqual(list(canonical.iterdir()), [])
            self.assertEqual(list(installed.iterdir()), [])

    def test_desktop_check_prints_selected_legacy_profile_without_writes(self):
        home = Path(self.temp.name)
        state = home / 'Library/Application Support/SoduWork/custom-service'
        with patch.object(Path, 'home', return_value=home), patch.object(sys, 'platform', 'darwin'), \
                patch.object(start, 'dependency_report'), patch.object(start, 'check_desktop_session'), \
                patch.object(start, 'initialize') as initialize, \
                patch.object(start, 'prepare') as prepare, patch.object(start, 'serve') as serve, \
                redirect_stdout(io.StringIO()) as output:
            canonical = start.desktop_profile(state)
            legacy = canonical.parent / 'source-service-desktops' / canonical.name.removeprefix('source-service-desktop-')
            legacy.mkdir(parents=True)
            before = sorted(str(p.relative_to(home)) for p in home.rglob('*'))
            self.assertEqual(start.main(['--desktop', '--check', '--data-dir', str(state)]), 0)
            self.assertIn('Desktop profile: ' + str(legacy), output.getvalue())
            self.assertEqual(sorted(str(p.relative_to(home)) for p in home.rglob('*')), before)
            for operation in (initialize, prepare, serve):
                operation.assert_not_called()

    def test_refuses_existing_unrelated_data_without_changes(self):
        self.state.mkdir()
        private = self.state / ".env"
        private.write_text("DATABASE_URL=do-not-touch", encoding="utf-8")
        with self.assertRaisesRegex(start.StartupError, "not empty"):
            start.initialize(self.state, "admin")
        self.assertEqual(private.read_text(), "DATABASE_URL=do-not-touch")
        self.assertFalse((self.state / "local-service.json").exists())

    def test_first_setup_failure_can_resume_without_password_in_config(self):
        config = start.initialize(self.state, "owner")
        with patch("sys.stdin", io.StringIO("short\n")):
            with self.assertRaisesRegex(start.StartupError, "12-128"):
                start.password_for_start(self.state, config, True)
        again = start.initialize(self.state, "other")
        self.assertEqual(config, again)
        with patch("sys.stdin", io.StringIO("a-long-private-password\n")):
            self.assertEqual(start.password_for_start(self.state, again, True), "a-long-private-password")
        serialized = (self.state / "local-service.json").read_text(encoding="utf-8")
        self.assertNotIn("a-long-private-password", serialized)
        self.assertNotIn("password", serialized.lower())

    def test_existing_account_never_prompts_or_changes_password(self):
        config = start.initialize(self.state, "admin")
        with closing(sqlite3.connect(self.state / "soduwork.db")) as db:
            db.execute("CREATE TABLE app_user (id INTEGER, password_hash TEXT)")
            db.execute("INSERT INTO app_user VALUES (1, 'existing-password-hash')")
            db.commit()
        with patch("sys.stdin", io.StringIO("must-not-consume\n")) as stream:
            self.assertTrue(start.password_for_start(self.state, config, True))
            self.assertEqual(stream.tell(), 0)
        with closing(sqlite3.connect(self.state / "soduwork.db")) as db:
            self.assertEqual(db.execute("SELECT password_hash FROM app_user").fetchone()[0], "existing-password-hash")

    def test_damaged_database_reports_startup_error_instead_of_traceback(self):
        # A truncated/non-SQLite file (disk full, interrupted migration, partial
        # copy) raises sqlite3.DatabaseError, not the OperationalError subclass.
        self.state.mkdir()
        (self.state / "soduwork.db").write_bytes(b"this is not a sqlite database")
        with self.assertRaisesRegex(start.StartupError, "Cannot inspect the local database"):
            start.initialized(self.state)

    def test_damaged_database_surfaces_friendly_error_through_password_prompt(self):
        config = start.initialize(self.state, "admin")
        (self.state / "soduwork.db").write_bytes(b"\x00\x01not-a-database")
        with patch("sys.stdin", io.StringIO("must-not-consume\n")) as stream:
            with self.assertRaisesRegex(start.StartupError, "Cannot inspect the local database"):
                start.password_for_start(self.state, config, True)
            self.assertEqual(stream.tell(), 0)

    def test_empty_database_still_means_not_initialized(self):
        # Regression guard: "no such table" is an OperationalError and must keep
        # returning False rather than being treated as a damaged database.
        self.state.mkdir()
        with closing(sqlite3.connect(self.state / "soduwork.db")):
            pass
        self.assertFalse(start.initialized(self.state))

    def test_no_inherited_database_or_account_or_remote_store(self):
        config = start.initialize(self.state, "admin")
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://production", "AUTH_SECRET": "company-key",
                                     "MINIO_ENDPOINT": "company-storage", "OPENAI_API_KEY": "private-model-key",
                                     "CLUSTER_REDIS_URL": "redis://production", "PYTHONPATH": "untrusted-path"}):
            env = start.runtime_environment(self.state, config, "not-written", "127.0.0.1", 18991)
        self.assertIn(str(self.state.as_posix()), env["DATABASE_URL"])
        for key in ("MINIO_ENDPOINT", "OPENAI_API_KEY", "CLUSTER_REDIS_URL", "PYTHONPATH"):
            self.assertNotIn(key, env)
        self.assertEqual(env["AUTH_SECRET"], config["authSecret"])
        self.assertEqual(env["HOME"], str(self.state / "home"))
        self.assertEqual(env["DEVICE_AUTH_COMPAT"], "false")

    def test_source_sync_filters_secrets_and_removes_only_generated_stale_files(self):
        source = Path(self.temp.name) / "source"
        source.mkdir()
        (source / "api.py").write_text("print('new')", encoding="utf-8")
        (source / ".env").write_text("secret", encoding="utf-8")
        (source / "user.db").write_bytes(b"private")
        (source / "__pycache__").mkdir()
        (source / "__pycache__/api.pyc").write_bytes(b"cache")
        app = self.state / "application/hub-backend/app"
        app.mkdir(parents=True)
        (app / "obsolete.py").write_text("old", encoding="utf-8")
        uploads = app.parent / "uploads"
        uploads.mkdir()
        (uploads / "user-document.txt").write_text("retained", encoding="utf-8")
        build.sync_source(source, app)
        self.assertEqual([p.name for p in app.iterdir()], ["api.py"])
        self.assertEqual((uploads / "user-document.txt").read_text(), "retained")

    def test_checkout_ignored_files_are_not_copied(self):
        source = Path(self.temp.name) / "checkout"
        source.mkdir()
        trusted = source / "source.py"
        trusted.write_text("pass", encoding="utf-8")
        (source / "private-key.pem").write_text("ignored private fixture", encoding="utf-8")
        with patch.object(build, "ROOT", source), patch.object(build, "checkout_files", return_value={trusted}):
            self.assertEqual(list(build.source_files(source)), [trusted])

    def test_source_sync_replaces_a_generated_file_with_a_package(self):
        source = Path(self.temp.name) / 'source'
        source.mkdir()
        module = source / 'module'
        module.write_text('old module', encoding='utf-8')
        target = self.state / 'application/client'
        dependency = target / 'node_modules/fixture'
        dependency.parent.mkdir(parents=True)
        dependency.write_text('installed dependency', encoding='utf-8')
        preserve = frozenset({'node_modules'})
        build.sync_source(source, target, preserve=preserve)
        module.unlink()
        package = module / 'nested'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('new package', encoding='utf-8')
        build.sync_source(source, target, preserve=preserve)
        self.assertEqual((target / 'module/nested/__init__.py').read_text(encoding='utf-8'), 'new package')
        self.assertEqual(dependency.read_text(encoding='utf-8'), 'installed dependency')
        build.sync_source(source, target, preserve=preserve)
        self.assertEqual((target / 'module/nested/__init__.py').read_text(encoding='utf-8'), 'new package')

    def test_source_sync_replaces_a_generated_package_with_a_file(self):
        source = Path(self.temp.name) / 'source'
        package = source / 'nested/module'
        package.mkdir(parents=True)
        original = package / 'old.py'
        original.write_text('old package', encoding='utf-8')
        target = self.state / 'application/hub-backend/app'
        upload = target.parent / 'uploads/document.txt'
        upload.parent.mkdir(parents=True)
        upload.write_text('user document', encoding='utf-8')
        build.sync_source(source, target)
        original.unlink()
        package.rmdir()
        package.write_text('new module', encoding='utf-8')
        build.sync_source(source, target)
        self.assertEqual((target / 'nested/module').read_text(encoding='utf-8'), 'new module')
        self.assertEqual(upload.read_text(encoding='utf-8'), 'user document')
        build.sync_source(source, target)
        self.assertEqual((target / 'nested/module').read_text(encoding='utf-8'), 'new module')

    def test_cancelled_dependency_command_reaps_its_child(self):
        seen = []

        def interrupt(child, **_kwargs):
            seen.append(child)
            try:
                child.wait(timeout=.1)
            except subprocess.TimeoutExpired:
                raise KeyboardInterrupt()
            self.fail("Fixture should still be running")

        with patch.object(build, "wait_child", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                build.run([sys.executable, "-c", "import time; time.sleep(60)"],
                          cwd=Path(self.temp.name), log=Path(self.temp.name) / "install.log", label="Cancellation fixture")
        self.assertEqual(len(seen), 1)
        self.assertIsNotNone(seen[0].poll())

    def test_timed_out_download_reaps_its_process_and_allows_retry(self):
        root = Path(self.temp.name)
        marker = root / 'finished'
        command = [sys.executable, '-c',
                   'import time,pathlib,sys; time.sleep(2); pathlib.Path(sys.argv[1]).touch()', str(marker)]
        with self.assertRaisesRegex(build.StartupError, 'timed out') as failure:
            build.run(command, cwd=root, log=root / 'download.log', label='Download fixture', timeout=.1)
        self.assertNotIn('network/proxy', str(failure.exception))
        self.assertFalse(marker.exists())
        build.run([sys.executable, '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).touch()', str(marker)],
                  cwd=root, log=root / 'download.log', label='Retry fixture', timeout=5)
        self.assertTrue(marker.exists())

    def test_failed_command_reports_disk_full_without_exposing_output(self):
        self.state.mkdir()
        log = self.state / 'startup.log'
        for diagnostic in ('OSError: [Errno 28] No space left on device',
                           'npm error code ENOSPC',
                           'OSError: [WinError 112] There is not enough space on the disk'):
            with self.subTest(diagnostic=diagnostic), redirect_stdout(io.StringIO()) as console:
                command = [sys.executable, '-c',
                           'import sys; print(sys.argv[1], file=sys.stderr); sys.exit(1)',
                           diagnostic + '\nprivate diagnostic fixture']
                with self.assertRaisesRegex(build.StartupError, 'Disk full') as failure:
                    build.run(command, cwd=self.state, log=log, label='Install fixture')
                message = str(failure.exception)
                self.assertIn(str(log), message)
                self.assertNotIn('network/proxy', message)
                self.assertNotIn('private diagnostic fixture', message + console.getvalue())

    def test_failed_command_does_not_reuse_an_old_disk_full_diagnostic(self):
        self.state.mkdir()
        log = self.state / 'startup.log'
        log.write_text('Previous attempt: ENOSPC\n', encoding='utf-8')
        command = [sys.executable, '-c',
                   'import sys; print("No matching distribution found for fixture", file=sys.stderr); sys.exit(1)']
        with self.assertRaises(build.StartupError) as failure, redirect_stdout(io.StringIO()):
            build.run(command, cwd=self.state, log=log, label='Install fixture')
        self.assertIn(str(log), str(failure.exception))
        self.assertNotIn('Disk full', str(failure.exception))
        self.assertNotIn('network/proxy', str(failure.exception))

    def test_busy_port_is_left_running(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(start.StartupError, "already in use"):
                start.assert_available("127.0.0.1", port)
            self.assertEqual(listener.getsockname()[1], port)

    @unittest.skipUnless(socket.has_ipv6, "IPv6 is not available")
    def test_ipv6_port_is_available_only_after_listener_closes(self):
        with socket.socket(socket.AF_INET6) as listener:
            try:
                listener.bind(("::1", 0))
            except OSError as exc:
                self.skipTest(f"IPv6 loopback is not available: {exc}")
            listener.listen()
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(start.StartupError, "already in use"):
                start.assert_available("::1", port)
            self.assertEqual(listener.getsockname()[1], port)
        start.assert_available("::1", port)

    def test_runtime_environment_uses_bracketed_ipv6_urls(self):
        config = {"adminUser": "admin", "authSecret": "x" * 48}
        for host, expected in (("::1", "http://[::1]:18991"),
                               ("2001:db8::1", "http://[2001:db8::1]:18991"),
                               ("127.0.0.1", "http://127.0.0.1:18991"),
                               ("localhost", "http://localhost:18991")):
            with self.subTest(host=host):
                env = start.runtime_environment(self.state, config, "fixture-only-password", host, 18991)
                self.assertEqual(env["HUB_PUBLIC_URL"], expected)
                self.assertEqual(env["CORS_ORIGINS"], expected + ",null")

    def test_preparation_failure_leaves_first_password_unread(self):
        config = {"adminUser": "admin"}
        for desktop in (False, True):
            args = Namespace(host="127.0.0.1", port=18991, desktop=desktop, password_stdin=True)
            failure = start.StartupError("download failed")
            with self.subTest(desktop=desktop), patch.object(start, "assert_available"), \
                    patch.object(start, "prepare", return_value=(None, None),
                                 side_effect=None if desktop else failure), \
                    patch.object(start, "prepare_desktop", side_effect=failure), \
                    patch("sys.stdin", io.StringIO("fixture-only-password\n")) as stream, \
                    redirect_stdout(io.StringIO()) as output:
                with self.assertRaisesRegex(start.StartupError, "download failed"):
                    start.serve(self.state, config, args)
                self.assertEqual(stream.tell(), 0)
                self.assertNotIn("Create the administrator account", output.getvalue())

    def test_install_command_cannot_read_the_launchers_stdin(self):
        with patch.object(build.subprocess, "Popen") as popen, patch.object(build, "wait_child", return_value=0):
            build.run(["installer"], cwd=Path(self.temp.name), log=Path(self.temp.name) / "startup.log",
                      label="Install fixture")
        self.assertEqual(popen.call_args.kwargs["stdin"], subprocess.DEVNULL)

    @unittest.skipUnless(os.name == "nt", "Windows batch entry point")
    def test_windows_password_stdin_returns_errors_with_input_pipe_open(self):
        env = dict(os.environ, SODUWORK_NO_PAUSE="0")
        command = ["cmd.exe", "/d", "/c", "start.cmd", "--data-dir", str(self.state / "data with spaces"),
                   "--port", "1", "--password-stdin"]
        with subprocess.Popen(command, cwd=build.ROOT, env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
            try:
                self.assertEqual(child.wait(timeout=15), 2)
                self.assertIn(b"port must be between", child.stdout.read())
            finally:
                build.stop_child(child)

    def test_serve_uses_ipv6_url_for_readiness_and_browser(self):
        config = {"adminUser": "admin", "authSecret": "x" * 48}
        args = Namespace(host="::1", port=18991, desktop=False, no_browser=False, password_stdin=True)
        with patch.object(start, "assert_available"), \
                patch.object(start, "initialized", return_value=True), \
                patch.object(start, "password_for_start", return_value="fixture-only-password"), \
                patch.object(start, "prepare", return_value=(Path(sys.executable), self.state / "backend")), \
                patch.object(start.subprocess, "Popen") as popen, \
                patch.object(start, "wait_ready") as ready, \
                patch.object(start, "open_management_page") as browser, \
                patch.object(start, "wait_child"), patch.object(start, "stop_child"), \
                redirect_stdout(io.StringIO()):
            child = popen.return_value
            child.returncode = 0
            start.serve(self.state, config, args)
        expected = "http://[::1]:18991"
        ready.assert_called_once_with(child, expected, self.state / "startup.log", timeout=90)
        browser.assert_called_once_with(expected)
        self.assertEqual(popen.call_args.args[0][-2:], ["--host", "::1"])
        self.assertEqual(popen.call_args.kwargs["env"]["HUB_PUBLIC_URL"], expected)

    @unittest.skipIf(os.name == "nt", "POSIX listener reuse; Windows uses exclusive bind")
    def test_closed_http_connection_allows_restart_but_live_reusable_listener_does_not(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(start.StartupError, "already in use"):
                start.assert_available("127.0.0.1", port)
            with socket.create_connection(("127.0.0.1", port), timeout=2) as peer:
                accepted, _ = listener.accept()
                accepted.close()
                self.assertEqual(peer.recv(1), b"")
        start.assert_available("127.0.0.1", port)

    def test_check_is_read_only_even_for_a_new_data_directory(self):
        with patch.dict(os.environ, {'DISPLAY': ':fixture'}), \
                patch.object(start, 'dependency_report') as report, patch.object(start, 'initialize') as initialize:
            self.assertEqual(start.main(['--check', '--desktop', '--data-dir', str(self.state)]), 0)
        report.assert_called_once_with(desktop=True)
        initialize.assert_not_called()
        self.assertFalse(self.state.exists())

    def test_prepare_only_never_requests_password_or_starts_a_server(self):
        with patch.dict(os.environ, {'DISPLAY': ':fixture'}), \
                patch.object(start, 'check_dependencies'), patch.object(start, 'prepare') as prepare, \
                patch.object(start, 'prepare_desktop') as desktop, patch.object(start, 'serve') as serve, \
                patch.object(start, 'password_for_start') as password:
            self.assertEqual(start.main(['--prepare-only', '--desktop', '--data-dir', str(self.state)]), 0)
        prepare.assert_called_once()
        desktop.assert_called_once()
        password.assert_not_called()
        serve.assert_not_called()
        self.assertFalse((self.state / 'soduwork.db').exists())

    def test_desktop_profile_targets_the_started_service_without_inherited_credentials(self):
        start.initialize(self.state, 'owner')
        env = start.runtime_environment(self.state, {'adminUser': 'owner', 'authSecret': 'x' * 48},
                                        'fixture-only-password', '127.0.0.1', 18990)
        client = self.state / 'application/client'
        with patch.object(start.subprocess, 'Popen') as popen:
            start.launch_desktop(self.state, client, env, 'http://127.0.0.1:18990', io.BytesIO())
        child_env = popen.call_args.kwargs['env']
        self.assertEqual(child_env['SODUWORK_USER_DATA'], str(self.state / 'desktop-profile'))
        self.assertNotIn('SODUWORK_TEST_HUB_URL', child_env)
        self.assertEqual(child_env['SODUWORK_SOURCE_SESSION'], '1')
        self.assertEqual(child_env['VIRTUAL_ENV'], str(self.state / 'venv'))
        self.assertEqual(child_env['SODUWORK_SOURCE_RUNNER_PYTHON'], str(self.state / 'venv' /
                         ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')))
        for name in ('ADMIN_PASS', 'AUTH_SECRET', 'DATABASE_URL'):
            self.assertNotIn(name, child_env)
        for name in ('SYSTEMDRIVE', 'PROGRAMDATA'):
            if name in os.environ:
                self.assertEqual(child_env[name], os.environ[name])
        import json
        self.assertEqual(json.loads((self.state / 'desktop-profile/hub-endpoint.json').read_text()),
                         {'hub': 'http://127.0.0.1:18990'})
        self.assertEqual(json.loads((self.state / 'desktop-profile/chat-config.json').read_text()),
                         {'workDir': str(self.state / 'workspaces')})

    def test_macos_desktop_preserves_native_home_without_inheriting_service_secrets(self):
        native_home = Path(self.temp.name) / 'native-home'
        config = start.initialize(self.state, 'owner')
        with patch.dict(os.environ, {'HOME': str(native_home), 'OPENAI_API_KEY': 'fixture-only-key'}):
            service_env = start.runtime_environment(self.state, config, 'fixture-only-password',
                                                    '127.0.0.1', 18990)
            with patch.object(start.sys, 'platform', 'darwin'), \
                    patch.object(Path, 'home', return_value=native_home), \
                    patch.object(start.subprocess, 'Popen') as popen:
                start.launch_desktop(self.state, self.state / 'application/client', service_env,
                                     'http://127.0.0.1:18990', io.BytesIO())
        desktop_env = popen.call_args.kwargs['env']
        self.assertEqual(desktop_env['HOME'], str(native_home))
        self.assertEqual(service_env['HOME'], str(self.state / 'home'))
        self.assertEqual(desktop_env['SODUWORK_USER_DATA'], str(self.state / 'desktop-profile'))
        for key in ('ADMIN_USER', 'ADMIN_PASS', 'AUTH_SECRET', 'DATABASE_URL', 'OPENAI_API_KEY'):
            self.assertNotIn(key, desktop_env)

    def test_linux_desktop_retains_login_session_and_native_keyring_paths(self):
        native_home = Path(self.temp.name) / 'native-home'
        sessions = [
            {'XDG_CURRENT_DESKTOP': 'ubuntu:GNOME', 'DESKTOP_SESSION': 'ubuntu',
             'XDG_SESSION_TYPE': 'wayland', 'XDG_SESSION_DESKTOP': 'ubuntu',
             'WAYLAND_DISPLAY': 'wayland-fixture', 'DISPLAY': ':fixture'},
            {'XDG_CURRENT_DESKTOP': 'KDE', 'DESKTOP_SESSION': 'plasma',
             'XDG_SESSION_TYPE': 'x11', 'KDE_SESSION_VERSION': '6',
             'KDE_FULL_SESSION': 'true', 'DISPLAY': ':fixture'},
        ]
        for session in sessions:
            with self.subTest(session=session['XDG_CURRENT_DESKTOP']):
                inherited = {**session, 'HOME': str(native_home),
                             'XDG_CONFIG_HOME': str(native_home / 'custom-config'),
                             'XDG_DATA_HOME': str(native_home / 'custom-data'),
                             'XDG_CACHE_HOME': str(native_home / 'custom-cache'),
                             'XDG_RUNTIME_DIR': '/run/user/fixture',
                             'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/fixture/bus',
                             'XAUTHORITY': str(native_home / '.Xauthority'),
                             'OPENAI_API_KEY': 'fixture-only-key',
                             'SODUWORK_ALLOW_INSECURE_KEYSTORE': '1',
                             'ELECTRON_DISABLE_SANDBOX': '1'}
                with patch.dict(os.environ, inherited, clear=True), \
                        patch.object(start.sys, 'platform', 'linux'), \
                        patch.object(Path, 'home', return_value=native_home), \
                        patch.object(start.subprocess, 'Popen') as popen:
                    service_env = start.runtime_environment(
                        self.state, {'adminUser': 'owner', 'authSecret': 'fixture-secret'},
                        'fixture-password', '127.0.0.1', 18990)
                    before = dict(service_env)
                    start.launch_desktop(self.state, self.state / 'application/client', service_env,
                                         'http://127.0.0.1:18990', io.BytesIO())
                desktop_env = popen.call_args.kwargs['env']
                for key, value in inherited.items():
                    if key in {'OPENAI_API_KEY', 'SODUWORK_ALLOW_INSECURE_KEYSTORE',
                               'ELECTRON_DISABLE_SANDBOX'}:
                        self.assertNotIn(key, desktop_env)
                    else:
                        self.assertEqual(desktop_env[key], value)
                self.assertEqual(service_env, before, 'desktop setup must not weaken service isolation')
                self.assertEqual(service_env['HOME'], str(self.state / 'home'))
                self.assertNotIn('XDG_CURRENT_DESKTOP', service_env)
                self.assertEqual(desktop_env['SODUWORK_USER_DATA'], str(self.state / 'desktop-profile'))
                for key in ('ADMIN_USER', 'ADMIN_PASS', 'AUTH_SECRET', 'DATABASE_URL'):
                    self.assertNotIn(key, desktop_env)

    def test_linux_desktop_uses_native_xdg_defaults_without_inventing_a_session(self):
        native_home = Path(self.temp.name) / 'native-home'
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(start.sys, 'platform', 'linux'), \
                patch.object(Path, 'home', return_value=native_home), \
                patch.object(start.subprocess, 'Popen') as popen:
            service_env = start.runtime_environment(
                self.state, {'adminUser': 'owner', 'authSecret': 'fixture-secret'},
                'fixture-password', '127.0.0.1', 18990)
            start.launch_desktop(self.state, self.state / 'application/client', service_env,
                                 'http://127.0.0.1:18990', io.BytesIO())
        desktop_env = popen.call_args.kwargs['env']
        self.assertEqual(desktop_env['HOME'], str(native_home))
        for key in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_DIRS',
                    'XDG_DATA_DIRS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'WAYLAND_DISPLAY'):
            self.assertNotIn(key, desktop_env)

    def test_linux_desktop_environment_changes_do_not_apply_to_other_platforms(self):
        # sys.platform is shared with shutil; keep executable discovery host-independent.
        for platform in ('win32', 'darwin'):
            with self.subTest(platform=platform), \
                    patch.dict(os.environ, {'XDG_CURRENT_DESKTOP': 'GNOME',
                                           'XDG_SESSION_TYPE': 'wayland',
                                           'XDG_DATA_HOME': '/native-data'}, clear=True), \
                    patch.object(start.sys, 'platform', platform), \
                    patch('shutil.which', return_value='fixture-node'), \
                    patch.object(Path, 'home', return_value=Path(self.temp.name) / 'native-home'), \
                    patch.object(start.subprocess, 'Popen') as popen:
                service_env = start.runtime_environment(
                    self.state, {'adminUser': 'owner', 'authSecret': 'fixture-secret'},
                    'fixture-password', '127.0.0.1', 18990)
                start.launch_desktop(self.state, self.state / 'application/client', service_env,
                                     'http://127.0.0.1:18990', io.BytesIO())
                desktop_env = popen.call_args.kwargs['env']
                self.assertEqual(desktop_env['XDG_DATA_HOME'], service_env['XDG_DATA_HOME'])
                self.assertEqual(desktop_env['XDG_CONFIG_HOME'], service_env['XDG_CONFIG_HOME'])
                self.assertNotIn('XDG_CURRENT_DESKTOP', desktop_env)
                self.assertNotIn('XDG_SESSION_TYPE', desktop_env)

    def test_source_refresh_preserves_desktop_dependencies_but_removes_stale_code(self):
        source = Path(self.temp.name) / 'source'
        source.mkdir()
        (source / 'main.js').write_text('updated')
        target = self.state / 'application/client'
        dependency = target / 'node_modules/electron/dist/fixture'
        dependency.parent.mkdir(parents=True)
        dependency.write_text('installed runtime')
        (target / 'retired.js').write_text('old code')
        build.sync_source(source, target, preserve=frozenset({'node_modules'}))
        self.assertEqual(dependency.read_text(), 'installed runtime')
        self.assertEqual((target / 'main.js').read_text(), 'updated')
        self.assertFalse((target / 'retired.js').exists())

    def test_desktop_launch_preserves_a_user_selected_workspace(self):
        profile = self.state / 'desktop-profile'
        profile.mkdir(parents=True)
        config = profile / 'chat-config.json'
        config.write_text('{"workDir":"chosen-workspace","other":"preserved"}')
        with patch.object(start.subprocess, 'Popen'):
            start.launch_desktop(self.state, self.state / 'application/client', {},
                                 'http://127.0.0.1:18990', io.BytesIO())
        self.assertEqual(config.read_text(), '{"workDir":"chosen-workspace","other":"preserved"}')

    def test_failed_desktop_download_is_not_cached_as_ready(self):
        client = self.state / 'application/client'
        client.mkdir(parents=True)
        (client / 'package-lock.json').write_text('{}')
        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'run'), patch.dict(os.environ, {'DISPLAY': ':fixture'}):
            with self.assertRaisesRegex(build.StartupError, 'Electron was not downloaded'):
                build.prepare_desktop(self.state, self.state / 'startup.log')
        self.assertFalse((self.state / 'desktop-dependencies.sha256').exists())

    def cached_desktop(self):
        client = self.state / 'application/client'
        client.mkdir(parents=True)
        lock = client / 'package-lock.json'
        lock.write_text('{}')
        binary = build.electron_binary(client)
        binary.parent.mkdir(parents=True)
        binary.write_text('electron fixture')
        (self.state / 'desktop-dependencies.sha256').write_text(
            build.hashlib.sha256(lock.read_bytes()).hexdigest())
        return client

    def test_cached_windows_desktop_verifies_shell_on_each_start(self):
        with patch.object(sys, 'platform', 'win32'):
            client = self.cached_desktop()
            log = self.state / 'startup.log'
            with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                    patch.object(build, 'run') as run:
                for _ in range(2):
                    self.assertEqual(build.prepare_desktop(self.state, log), client)
            self.assertEqual(run.call_count, 2)
            for call in run.call_args_list:
                self.assertEqual(call.args[0], [
                    'node', str(client / 'scripts/prepare-shell-runtime.cjs')])
                self.assertEqual(call.kwargs['cwd'], client)
                self.assertEqual(call.kwargs['log'], log)

    def test_desktop_install_includes_build_dependencies_in_production_environments(self):
        client = self.cached_desktop()
        for environment in ({'NODE_ENV': 'production'}, {'NPM_CONFIG_OMIT': 'dev'}):
            with self.subTest(environment=environment), \
                    patch.dict(os.environ, {'DISPLAY': ':fixture', **environment}), \
                    patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                    patch.object(build, 'run') as run:
                (self.state / 'desktop-dependencies.sha256').unlink(missing_ok=True)
                self.assertEqual(build.prepare_desktop(self.state, self.state / 'startup.log'), client)
                command = next(call.args[0] for call in run.call_args_list if call.args[0][:2] == ['npm', 'ci'])
                self.assertIn('--include=dev', command)
                self.assertIn('--ignore-scripts', command)

    def test_windows_shell_preparation_failure_stops_desktop_preparation(self):
        with patch.object(sys, 'platform', 'win32'):
            self.cached_desktop()
            with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                    patch.object(build, 'run', side_effect=build.StartupError('shell fixture failed')):
                with self.assertRaisesRegex(build.StartupError, 'shell fixture failed'):
                    build.prepare_desktop(self.state, self.state / 'startup.log')

    def test_prepare_keeps_package_caches_inside_the_data_directory(self):
        state = Path(self.temp.name) / 'cache-state'
        with patch.object(build.os, 'name', 'nt'), \
                patch.dict(os.environ, {'PATH': os.environ.get('PATH', '')}, clear=True):
            environment = build.prepare_environment(state)
        self.assertEqual(environment['npm_config_cache'], str(state / 'cache/npm'))
        self.assertEqual(environment['PIP_CACHE_DIR'], str(state / 'cache/pip'))
        self.assertEqual(environment['electron_config_cache'], str(state / 'cache/electron'))
        self.assertEqual(environment['PATH'], os.environ['PATH'])
        for key in ('TEMP', 'TMP', 'TMPDIR'):
            self.assertEqual(environment[key], str(state / 'cache/tmp'))

    def test_prepare_sets_tmpdir_on_posix(self):
        state = Path(self.temp.name) / 'cache-state'
        with patch.object(build.os, 'name', 'posix'), patch.dict(os.environ, {}, clear=True):
            environment = build.prepare_environment(state)
        self.assertEqual(environment['TMPDIR'], str(state / 'cache/tmp'))
        self.assertTrue((state / 'cache/tmp').is_dir())

    def test_prepare_children_really_create_temporary_files_inside_data_directory(self):
        outside = Path(self.temp.name) / 'user-temp'
        outside.mkdir()
        for platform_name in ('nt', 'posix'):
            with self.subTest(platform=platform_name):
                state = self.state / platform_name
                with patch.dict(os.environ, dict.fromkeys(('TEMP', 'TMP', 'TMPDIR'), str(outside))):
                    before = dict(os.environ)
                    with patch.object(build.os, 'name', platform_name):
                        environment = build.prepare_environment(state)
                    self.assertTrue(dict(os.environ) == before, 'Preparation changed the parent environment')
                commands = [
                    [sys.executable, '-c', 'import tempfile; f = tempfile.TemporaryFile(); '
                     'f.write(b"fixture"); f.close(); print(tempfile.gettempdir())'],
                    ['node', '-e', 'const fs = require("node:fs"), os = require("node:os"), '
                     'path = require("node:path"); fs.mkdtempSync(path.join(os.tmpdir(), "fixture-")); '
                     'console.log(os.tmpdir());'],
                ]
                for command in commands:
                    selected = subprocess.check_output(command, env=environment, text=True).strip()
                    self.assertEqual(Path(selected).resolve(), (state / 'cache/tmp').resolve())
        self.assertEqual(list(outside.iterdir()), [])

    def test_prepare_never_overrides_an_explicit_cache_choice(self):
        state = Path(self.temp.name) / 'cache-state'
        chosen = {'NPM_CONFIG_CACHE': '/operator/npm', 'PIP_CACHE_DIR': '/operator/pip',
                  'electron_config_cache': '/operator/electron'}
        with patch.dict(os.environ, chosen, clear=True):
            environment = build.prepare_environment(state)
        lowered = {key.lower(): value for key, value in environment.items()}
        for key, value in chosen.items():
            self.assertEqual(lowered[key.lower()], value)

    def test_empty_cache_settings_do_not_fall_back_to_user_profile(self):
        with patch.dict(os.environ, {'NPM_CONFIG_CACHE': '', 'PIP_CACHE_DIR': '',
                                     'electron_config_cache': ''}, clear=True):
            environment = build.prepare_environment(self.state)
        lowered = {key.lower(): value for key, value in environment.items()}
        for key, folder in (('npm_config_cache', 'npm'), ('pip_cache_dir', 'pip'),
                            ('electron_config_cache', 'electron')):
            self.assertEqual(lowered[key], str(self.state / 'cache' / folder))

    def fake_venv_run(self, state):
        """Stand in for run() and materialize the interpreter a venv command would create.

        The launcher verifies the interpreter after creating the environment, so a
        double that only records commands would look like a failed venv creation.
        """
        interpreter = state / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')

        def run(command, **kwargs):
            if '-m' in command and 'venv' in command:
                interpreter.parent.mkdir(parents=True, exist_ok=True)
                interpreter.write_text('', encoding='utf-8')

        return run

    def test_prepare_passes_isolated_caches_to_every_install_command(self):
        state = Path(self.temp.name) / 'prepare-state'
        state.mkdir()
        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'sync_source'), patch.object(build, 'shutil'), \
                patch.object(build, 'source_files', return_value=[]), \
                patch.object(build, 'digest_files', return_value='digest'), \
                patch.object(build, 'read_stamp', return_value=None), \
                patch.object(build, 'run', side_effect=self.fake_venv_run(state)) as run:
            build.prepare(state, state / 'startup.log')
        installs = run.call_args_list
        self.assertEqual(len(installs), 5)  # venv, pip, Runner probe, npm ci, build
        self.assertTrue(any('pip' in call.args[0] for call in installs))
        for call in installs:
            self.assertTrue(call.kwargs.get('env') == build.prepare_environment(state),
                            'Every preparation child must receive the isolated environment')

    def test_cached_runner_disk_full_is_not_retried_as_a_dependency_repair(self):
        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'sync_source'), patch.object(build, 'shutil'), \
                patch.object(build, 'source_copy_targets', return_value=()), \
                patch.object(build, 'digest_files', return_value='digest'), \
                patch.object(build, 'read_stamp', return_value='digest'), \
                patch.object(build, 'verify_runner_environment', side_effect=build.DiskFullError('Disk full')), \
                patch.object(build, 'run', side_effect=self.fake_venv_run(self.state)) as run:
            with self.assertRaises(build.DiskFullError):
                build.prepare(self.state, self.state / 'startup.log')
        self.assertFalse(any('pip' in call.args[0] for call in run.call_args_list))

    def test_venv_command_success_without_interpreter_is_reported_and_logged(self):
        """创建命令返回成功、解释器仍缺失：必须报错，而且原因要写进 startup.log。"""
        state = Path(self.temp.name) / 'missing-interpreter'
        state.mkdir()
        log = state / 'startup.log'
        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'sync_source'), patch.object(build, 'shutil'), \
                patch.object(build, 'source_copy_targets', return_value=()), \
                patch.object(build, 'digest_files', return_value='digest'), \
                patch.object(build, 'read_stamp', return_value='digest'), \
                patch.object(build, 'run') as run:
            with self.assertRaises(build.StartupError) as raised:
                build.prepare(state, log)
        # 创建命令确实被执行过，然后才因为产物缺失退出
        self.assertTrue(any('-m' in call.args[0] and 'venv' in call.args[0] for call in run.call_args_list))
        expected = state / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        message = str(raised.exception)
        self.assertIn(str(expected), message)
        self.assertIn('interpreter that created the venv', message)
        logged = log.read_text(encoding='utf-8') if log.exists() else ''
        self.assertIn('--- 独立环境诊断 / private environment diagnosis ---', logged)
        self.assertIn('expected interpreter: ' + str(expected), logged)
        self.assertIn('interpreter that created the venv: ' + sys.executable, logged)

    def test_missing_interpreter_without_posix_layout_does_not_claim_msys2(self):
        """没有 POSIX 布局解释器时，不能提示用户去装 Windows 版 Python。"""
        state = Path(self.temp.name) / 'generic-missing'
        state.mkdir()
        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'sync_source'), patch.object(build, 'shutil'), \
                patch.object(build, 'source_copy_targets', return_value=()), \
                patch.object(build, 'digest_files', return_value='digest'), \
                patch.object(build, 'read_stamp', return_value='digest'), \
                patch.object(build, 'run'):
            with self.assertRaises(build.StartupError) as raised:
                build.prepare(state, state / 'startup.log')
        message = str(raised.exception)
        self.assertNotIn('MSYS2', message)
        self.assertNotIn('python.org', message)  # 非 Windows 不该给装 Windows Python 的建议
        self.assertIn('-m venv', message)        # 恢复办法仍然给出
        self.assertIn('os.name=' + os.name, message)

    @unittest.skipUnless(os.name == 'nt', 'MSYS2 布局只能在 Windows 上出现')
    def test_posix_venv_layout_on_windows_reports_msys2(self):
        """Windows 上 Scripts/python.exe 缺失而 venv/bin/python.exe 存在，才判定为 MSYS2 布局。"""
        state = Path(self.temp.name) / 'posix-layout'
        state.mkdir()
        posix = state / 'venv' / 'bin' / 'python.exe'

        def run(command, **kwargs):
            if '-m' in command and 'venv' in command:
                posix.parent.mkdir(parents=True, exist_ok=True)
                posix.write_text('', encoding='utf-8')

        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'sync_source'), patch.object(build, 'shutil'), \
                patch.object(build, 'source_copy_targets', return_value=()), \
                patch.object(build, 'digest_files', return_value='digest'), \
                patch.object(build, 'read_stamp', return_value='digest'), \
                patch.object(build, 'run', side_effect=run):
            with self.assertRaises(build.StartupError) as raised:
                build.prepare(state, state / 'startup.log')
        message = str(raised.exception)
        self.assertIn('MSYS2/Cygwin', message)
        self.assertIn(str(posix), message)

    def test_cached_nonwindows_desktop_does_not_prepare_windows_shell(self):
        with patch.object(sys, 'platform', 'darwin'):
            client = self.cached_desktop()
            with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                    patch.object(build, 'run') as run:
                self.assertEqual(build.prepare_desktop(self.state, self.state / 'startup.log'), client)
            run.assert_not_called()

    def test_electron_proxy_environment_honors_precedence_and_explicit_switches(self):
        cases = [
            ({}, None),
            ({'HTTP_PROXY': 'http://proxy.example:8080'}, '1'),
            ({'https_proxy': 'http://proxy.example:8080'}, '1'),
            ({'HTTPS_PROXY': 'http://upper.example:8080', 'https_proxy': ''}, None),
            ({'HTTP_PROXY': 'http://upper.example:8080', 'http_proxy': '',
              'https_proxy': 'http://lower.example:8080'}, '1'),
            ({'ALL_PROXY': 'http://proxy.example:8080'}, None),
            ({'ELECTRON_GET_USE_PROXY': 'true'}, '1'),
        ]
        for switch in ('', '0', 'false', 'FALSE', 'no', 'off', ' OFF '):
            cases.append(({'HTTPS_PROXY': 'http://proxy.example:8080',
                           'ELECTRON_GET_USE_PROXY': switch}, ''))
        for original, expected in cases:
            with self.subTest(environment=original), patch.object(build.os, 'environ', dict(original)):
                before = dict(build.os.environ)
                child = build.electron_install_environment()
                self.assertEqual(child.get('ELECTRON_GET_USE_PROXY'), expected)
                self.assertEqual(dict(build.os.environ), before)
                self.assertIsNot(child, build.os.environ)
                for key, value in original.items():
                    if key != 'ELECTRON_GET_USE_PROXY':
                        self.assertEqual(child[key], value)

    def test_desktop_proxy_opt_in_is_limited_to_the_electron_download_child(self):
        client = self.state / 'application/client'
        client.mkdir(parents=True)
        (client / 'package-lock.json').write_text('{}')
        environment = {'DISPLAY': ':fixture', 'https_proxy': 'http://proxy.example:8080',
                       'ELECTRON_MIRROR': 'https://mirror.example/electron/',
                       'NODE_EXTRA_CA_CERTS': 'fixture-ca.pem', 'NO_PROXY': 'localhost'}
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            if command[-1] == str(client / 'scripts/install-electron.cjs'):
                binary = build.electron_binary(client)
                binary.parent.mkdir(parents=True)
                binary.write_text('electron fixture')

        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'run', side_effect=run), \
                patch.object(build.os, 'environ', dict(environment)), \
                patch.object(sys, 'platform', 'win32'):
            self.assertEqual(build.prepare_desktop(self.state, self.state / 'startup.log'), client)
            self.assertEqual(dict(build.os.environ), environment)
        self.assertEqual(len(calls), 3)
        for index, (_, kwargs) in enumerate(calls):
            child = kwargs.get('env', {})
            self.assertEqual(child.get('npm_config_cache'), str(self.state / 'cache/npm'))
            self.assertEqual(child.get('PIP_CACHE_DIR'), str(self.state / 'cache/pip'))
            self.assertEqual(child.get('electron_config_cache'), str(self.state / 'cache/electron'))
            self.assertEqual(child.get('TMPDIR'), str(self.state / 'cache/tmp'))
            self.assertEqual(child.get('ELECTRON_GET_USE_PROXY'), '1' if index == 1 else None)
            for key, value in environment.items():
                self.assertEqual(child[key], value)

    def test_desktop_disk_full_does_not_add_network_advice_or_stamp_success(self):
        client = self.state / 'application/client'
        client.mkdir(parents=True)
        (client / 'package-lock.json').write_text('{}')
        real_run = build.run
        def fail_download(command, **kwargs):
            if command[-1] == str(client / 'scripts/install-electron.cjs'):
                real_run([sys.executable, '-c', 'import sys; print("ENOSPC"); sys.exit(1)'], **kwargs)
        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'run', side_effect=fail_download), \
                patch.dict(os.environ, {'DISPLAY': ':fixture'}), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(build.StartupError, 'Disk full') as failure:
                build.prepare_desktop(self.state, self.state / 'startup.log')
        self.assertNotIn('ELECTRON_MIRROR', str(failure.exception))
        self.assertNotIn('network', str(failure.exception).lower())
        self.assertFalse((self.state / 'desktop-dependencies.sha256').exists())

    def test_desktop_download_failure_keeps_overrides_and_reports_recovery(self):
        client = self.state / 'application/client'
        client.mkdir(parents=True)
        (client / 'package-lock.json').write_text('{}')
        calls = []
        def run(command, **kwargs):
            calls.append((command, kwargs))
            if command[0] == 'node':
                self.assertEqual(kwargs['env']['ELECTRON_MIRROR'], 'https://mirror.example/electron/')
                self.assertEqual(kwargs['env']['HTTPS_PROXY'], 'http://proxy.example:8080')
                self.assertEqual(kwargs['env']['ELECTRON_GET_USE_PROXY'], '1')
                raise build.StartupError('Download fixture timed out')
        with patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'run', side_effect=run), patch.dict(os.environ, {
                    'DISPLAY': ':fixture', 'ELECTRON_MIRROR': 'https://mirror.example/electron/',
                    'HTTPS_PROXY': 'http://proxy.example:8080',
                }):
            with self.assertRaisesRegex(build.StartupError, 'ELECTRON_MIRROR'):
                build.prepare_desktop(self.state, self.state / 'startup.log')
        self.assertEqual(calls[-1][1]['timeout'], build.ELECTRON_DOWNLOAD_TIMEOUT)
        self.assertEqual(calls[-1][0], ['node', str(client / 'scripts/install-electron.cjs')])
        self.assertFalse((self.state / 'desktop-dependencies.sha256').exists())

    def test_desktop_failure_is_reported_and_a_normal_quit_returns(self):
        from unittest.mock import Mock
        server = Mock(); server.poll.return_value = None
        desktop = Mock(); desktop.wait.return_value = 17
        with self.assertRaisesRegex(start.StartupError, 'desktop.log'):
            start.wait_session(server, desktop, self.state)
        desktop.wait.return_value = 0
        start.wait_session(server, desktop, self.state)

    def test_data_directory_inside_source_is_rejected_before_copying(self):
        target = build.ROOT / "skills/must-not-create-runtime-data"
        with patch("sys.stderr", io.StringIO()) as output:
            self.assertEqual(start.main(["--data-dir", str(target), "--no-browser"]), 1)
        self.assertIn("outside the source checkout", output.getvalue())
        self.assertFalse(target.exists())

    def test_corrupt_config_is_not_reset(self):
        self.state.mkdir()
        path = self.state / "local-service.json"
        path.write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(start.StartupError, "restore its backup"):
            start.initialize(self.state, "admin")
        self.assertEqual(path.read_text(), "{")

    def test_released_lock_can_be_reacquired(self):
        start.initialize(self.state, "admin")
        with self.assertRaisesRegex(RuntimeError, "fixture"):
            with start.exclusive(self.state):
                raise RuntimeError("fixture")
        with start.exclusive(self.state):
            self.assertTrue(True)

    def test_server_image_does_not_install_optional_opencode(self):
        dockerfile = (build.ROOT / "ops/self-host/Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("opencode-ai@", dockerfile)
        self.assertIn("COPY hub-backend/requirements-runner.txt", dockerfile)

    def test_private_source_copy_keeps_notices_and_rebuilds_shared_frontend_inputs(self):
        source = Path(self.temp.name) / "fixture-source"
        def put(name, text="fixture"):
            file = source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text, encoding="utf-8")
            return file
        for name in build.BACKEND_FILES:
            put("hub-backend/" + name)
        for name in ("hub-backend/app/api.py", "tools/dev/local_server.py", "skills/example/SKILL.md",
                     "client/core/connector-brand.js", "client/components/panels/connector-config.js",
                     "client/components/client-auth/legal-html.js", "client/components/client-auth/legal-html.css",
                     "client/assets/connector-brands/fixture.svg", "third-party/manifest.json", "LICENSE",
                     "hub-frontend/src/index.jsx", "hub-frontend/package.json", "hub-frontend/package-lock.json",
                     "hub-frontend/index.html", "hub-frontend/vite.config.js"):
            put(name)
        calls, commands, fault = [], [], {'probe_failures': 0}
        def run(_command, *, label, **_kwargs):
            calls.append(label)
            commands.append(_command)
            if label.startswith('[Runner]') and fault['probe_failures']:
                fault['probe_failures'] -= 1
                raise build.StartupError('fixture Runner dependency import failure')
            if "private Python" in label:
                python = self.state / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
                python.parent.mkdir(parents=True); python.write_text("fixture")
            if "Installing management" in label:
                (self.state / "application/hub-frontend/node_modules/vite").mkdir(parents=True)
            if "Building the management" in label:
                target = self.state / "application/hub-frontend/dist/index.html"
                target.parent.mkdir(parents=True, exist_ok=True); target.write_text("fixture")
        self.state.mkdir()
        with patch.object(build, "ROOT", source), patch.object(build, "check_dependencies", return_value=("node", "npm")), \
                patch.object(build, 'checkout_files', return_value=None), \
                patch.object(build, "run", side_effect=run):
            build.prepare(self.state, self.state / "startup.log")
            install = next(command for command in commands if 'pip' in command)
            for manifest in ('requirements.txt', 'requirements-runner.txt'):
                self.assertIn(str(source / 'hub-backend' / manifest), install)
            frontend_install = next(command for command in commands if command[:2] == ['npm', 'ci'])
            self.assertIn('--include=dev', frontend_install)
            for name in ("LICENSE", "third-party/manifest.json"):
                self.assertEqual((self.state / "application" / name).read_bytes(), (source / name).read_bytes())
            generated = [self.state / 'application/client' / relative for relative in (
                '.runtime/git/bin/bash.exe', '.runtime-cache/portable-git.part')]
            for file in generated:
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'generated runtime fixture')
            calls.clear()
            put("client/assets/connector-brands/fixture.svg", "updated artwork")
            build.prepare(self.state, self.state / "startup.log")
            self.assertEqual(calls, ["[Runner] 检查本地运行环境 / Checking the local Runner environment",
                                     "[4/4] 构建管理页面 / Building the management UI"])
            self.assertEqual((self.state / "application/client/assets/connector-brands/fixture.svg").read_text(), "updated artwork")
            for file in generated:
                self.assertEqual(file.read_bytes(), b'generated runtime fixture')
            for relative in ('client/components/client-auth/legal-html.js',
                             'client/components/client-auth/legal-html.css'):
                with self.subTest(shared_frontend_source=relative):
                    calls.clear()
                    put(relative, 'updated shared legal document resource')
                    build.prepare(self.state, self.state / 'startup.log')
                    self.assertEqual(calls, [
                        '[Runner] 检查本地运行环境 / Checking the local Runner environment',
                        '[4/4] 构建管理页面 / Building the management UI'])
                    self.assertEqual((self.state / 'application' / relative).read_text(),
                                     'updated shared legal document resource')
            calls.clear()
            build.prepare(self.state, self.state / 'startup.log')
            self.assertEqual(calls, ['[Runner] 检查本地运行环境 / Checking the local Runner environment'])
            before = (self.state / 'python-dependencies.sha256').read_text()
            put('hub-backend/requirements-runner.txt', 'updated Runner dependencies')
            commands.clear()
            build.prepare(self.state, self.state / 'startup.log')
            self.assertTrue(any('pip' in command for command in commands))
            self.assertNotEqual((self.state / 'python-dependencies.sha256').read_text(), before)
            commands.clear()
            fault['probe_failures'] = 1
            build.prepare(self.state, self.state / 'startup.log')
            self.assertTrue(any('pip' in command for command in commands), 'A broken cached environment is repaired')
            before = (self.state / 'python-dependencies.sha256').read_text()
            put('hub-backend/requirements-runner.txt', 'unverified Runner dependencies')
            fault['probe_failures'] = 1
            with self.assertRaisesRegex(build.StartupError, 'dependency import failure'):
                build.prepare(self.state, self.state / 'startup.log')
            self.assertEqual((self.state / 'python-dependencies.sha256').read_text(), before,
                             'Failed readiness checks cannot stamp an unusable environment as installed')

    def test_interactive_password_recovers_without_restarting_or_printing_secrets(self):
        config = start.initialize(self.state, 'admin')
        output = io.StringIO()
        with patch.object(start.sys.stdin, 'isatty', return_value=True), \
                patch.object(start.getpass, 'getpass', side_effect=['short', 'fixture-password-one', 'fixture-password-two',
                                                                  'fixture-password-final', 'fixture-password-final']), \
                redirect_stdout(output):
            self.assertEqual(start.password_for_start(self.state, config, False), 'fixture-password-final')
        self.assertIn('please try again', output.getvalue())
        self.assertIn('Passwords did not match', output.getvalue())
        self.assertNotIn('fixture-password', output.getvalue())
        self.assertNotIn('fixture-password', (self.state / 'local-service.json').read_text())

    def test_slow_install_prints_liveness_without_exposing_subprocess_output(self):
        from unittest.mock import Mock
        child = Mock()
        child.wait.side_effect = [subprocess.TimeoutExpired('private command', .5),
                                  subprocess.TimeoutExpired('private command', .5), 0]
        output = io.StringIO()
        with patch.object(build.time, 'monotonic', side_effect=[0, 15, 30]), redirect_stdout(output):
            self.assertEqual(build.wait_child(child, progress_label='Installing dependencies'), 0)
        self.assertEqual(output.getvalue().count('Still running'), 2)
        self.assertNotIn('private command', output.getvalue())

    def test_browser_failure_leaves_manual_local_address_available(self):
        for failure in [False, OSError('no desktop browser'), start.webbrowser.Error('no browser')]:
            output = io.StringIO()
            with patch.object(start.webbrowser, 'open', **({'side_effect': failure} if isinstance(failure, Exception)
                                                        else {'return_value': failure})), redirect_stdout(output):
                start.open_management_page('http://127.0.0.1:18990')
            self.assertIn('http://127.0.0.1:18990', output.getvalue())


class WindowsPathPreflightTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='soduwork-path-unit-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.state = self.root / 'service'
        self.state.mkdir()

    def relative_target(self, units):
        """Make a destination of an exact UTF-16 length with ordinary components."""
        parent = self.state / 'application'
        while units - len(str(parent).encode('utf-16-le')) // 2 - 1 > 100:
            parent /= 'segment-' + 'x' * 60
        remaining = units - len(str(parent).encode('utf-16-le')) // 2 - 1
        return (parent / ('x' * remaining)).relative_to(self.state)

    def test_windows_path_length_counts_utf16_units(self):
        for text in ('C:/short/path.py', 'C:/含 空格/文件.py', 'C:/\U0001f600/\U0001f680.py'):
            with self.subTest(path=text):
                self.assertEqual(path_check.windows_path_units(Path(text)),
                                 len(str(Path(text)).encode('utf-16-le')) // 2)

    def test_registry_diagnostic_only_reads_and_handles_unavailable_settings(self):
        registry = MagicMock()
        with patch.dict(sys.modules, {'winreg': registry}):
            for value, expected in ((0, False), (1, True)):
                with self.subTest(value=value):
                    registry.QueryValueEx.return_value = (value, 4)
                    self.assertIs(path_check.windows_long_paths_enabled(), expected)
            registry.OpenKey.side_effect = PermissionError('registry access unavailable')
            self.assertIsNone(path_check.windows_long_paths_enabled())
        registry.CreateKey.assert_not_called()
        registry.SetValue.assert_not_called()
        registry.SetValueEx.assert_not_called()
        registry.DeleteValue.assert_not_called()

    def test_probe_matches_target_utf16_length_without_random_name_overhead(self):
        self.state = self.state / '含 空格 \U0001f600'
        self.state.mkdir()
        existing = {'local-service.json': b'{"adminUser":"fixture"}',
                    'soduwork.db': b'SQLite format 3\x00historical fixture bytes'}
        for name, content in existing.items():
            (self.state / name).write_bytes(content)
        original_write, original_read = Path.write_bytes, Path.read_bytes
        written = {}

        def write(path, data):
            if len(str(path).encode('utf-16-le')) // 2 >= 260:
                written[path] = data
                return len(data)
            return original_write(path, data)

        def read(path):
            return written[path] if path in written else original_read(path)

        # Simulate a capable process even if its diagnostic registry value is 0.
        for length in (260, 265, 320):
            with self.subTest(length=length), patch.object(sys, 'platform', 'win32'), \
                    patch.object(path_check, 'windows_long_paths_enabled', return_value=False), \
                    patch.object(Path, 'write_bytes', write), patch.object(Path, 'read_bytes', read):
                written.clear()
                path_check.check_windows_source_paths(self.state, [self.relative_target(length)], probe=True)
            self.assertEqual(len(written), 1)
            self.assertEqual(len(str(next(iter(written))).encode('utf-16-le')) // 2, length)
            self.assertEqual({file.name: file.read_bytes() for file in self.state.iterdir()}, existing)

    def test_short_targets_do_not_need_registry_or_write_probes(self):
        for length in (200, 259):
            with self.subTest(length=length), patch.object(sys, 'platform', 'win32'), \
                    patch.object(path_check, 'windows_long_paths_enabled') as registry, \
                    patch.object(path_check.tempfile, 'TemporaryDirectory') as temporary:
                path_check.check_windows_source_paths(self.state, [self.relative_target(length)], probe=True)
            registry.assert_not_called()
            temporary.assert_not_called()

    def test_long_path_errors_get_actionable_diagnostics_and_keep_existing_data(self):
        existing = {
            'local-service.json': b'{"adminUser":"fixture","authSecret":"synthetic-test"}',
            'soduwork.db': b'SQLite format 3\x00historical fixture bytes',
        }
        for name, content in existing.items():
            (self.state / name).write_bytes(content)
        original_write = Path.write_bytes
        for number, winerror in ((errno.ENOENT, None), (errno.ENAMETOOLONG, None),
                                 (errno.EINVAL, 3), (errno.EINVAL, 206)):
            failure = OSError(number, 'simulated path failure')
            if winerror is not None:
                failure.winerror = winerror

            def write(path, data):
                if len(str(path).encode('utf-16-le')) // 2 >= 260:
                    raise failure
                return original_write(path, data)

            with self.subTest(errno=number, winerror=winerror), \
                    patch.object(sys, 'platform', 'win32'), patch.object(Path, 'write_bytes', write):
                target = self.relative_target(265)
                with self.assertRaises(path_check.WindowsPathError) as raised:
                    path_check.check_windows_source_paths(self.state, [target], probe=True)
            message = str(raised.exception)
            for required in ('265', str(self.state / target), '--data-dir', 'existing data', 'Windows', '长路径'):
                self.assertIn(required, message)
            self.assertIs(raised.exception.__cause__, failure)
            self.assertEqual({file.name: file.read_bytes() for file in self.state.iterdir()}, existing)

    def test_probe_permission_and_disk_errors_are_not_misreported_as_long_paths(self):
        original_write = Path.write_bytes
        for number in (errno.EACCES, errno.EPERM, errno.ENOSPC):
            failure = OSError(number, 'simulated storage failure')

            def write(path, data):
                if len(str(path).encode('utf-16-le')) // 2 >= 260:
                    raise failure
                return original_write(path, data)

            with self.subTest(errno=number), patch.object(sys, 'platform', 'win32'), \
                    patch.object(Path, 'write_bytes', write):
                with self.assertRaises(OSError) as raised:
                    path_check.check_windows_source_paths(self.state, [self.relative_target(265)], probe=True)
            self.assertIs(raised.exception, failure)
            self.assertNotIsInstance(raised.exception, path_check.WindowsPathError)
            self.assertEqual(list(self.state.iterdir()), [])

    def test_missing_short_control_path_is_not_reported_as_a_long_path_failure(self):
        failure = FileNotFoundError(errno.ENOENT, 'control directory disappeared')
        with patch.object(sys, 'platform', 'win32'), \
                patch.object(Path, 'write_bytes', side_effect=failure):
            with self.assertRaises(FileNotFoundError) as raised:
                path_check.check_windows_source_paths(self.state, [self.relative_target(265)], probe=True)
        self.assertIs(raised.exception, failure)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_long_directory_creation_error_is_classified_before_file_write(self):
        original_mkdir = Path.mkdir
        failure = FileNotFoundError(errno.ENOENT, 'simulated directory length limit')
        failure.winerror = 3

        def mkdir(path, *args, **kwargs):
            if len(str(path).encode('utf-16-le')) // 2 >= 248:
                raise failure
            return original_mkdir(path, *args, **kwargs)

        with patch.object(sys, 'platform', 'win32'), patch.object(Path, 'mkdir', mkdir):
            with self.assertRaises(path_check.WindowsPathError) as raised:
                path_check.check_windows_source_paths(self.state, [self.relative_target(380)], probe=True)
        self.assertIs(raised.exception.__cause__, failure)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_check_reports_long_path_risk_without_creating_a_new_directory(self):
        self.state = self.root / 'new-service'
        output = io.StringIO()
        with patch.object(sys, 'platform', 'win32'), \
                patch.object(start, 'check_source_checkout'), patch.object(start, 'dependency_report'), \
                patch.object(start, 'source_copy_targets', return_value=[self.relative_target(265)]), \
                patch.object(path_check, 'windows_long_paths_enabled', return_value=False), \
                patch.object(Path, 'mkdir') as mkdir, patch.object(Path, 'open') as opened, \
                patch.object(start, 'initialize') as initialize, redirect_stdout(output):
            self.assertEqual(start.main(['--check', '--data-dir', str(self.state)]), 0)
        self.assertIn('265', output.getvalue())
        self.assertIn('read-only', output.getvalue())
        self.assertIn('LongPathsEnabled: 0', output.getvalue())
        for operation in (mkdir, opened, initialize):
            operation.assert_not_called()
        self.assertFalse(self.state.exists())

    def test_nonwindows_does_not_read_registry_consume_paths_or_write(self):
        def unexpected_paths():
            raise AssertionError('Windows path inventory was inspected on another OS')
            yield

        for platform in ('linux', 'darwin'):
            for probe in (False, True):
                with self.subTest(platform=platform, probe=probe), \
                        patch.object(sys, 'platform', platform), \
                        patch.object(path_check, 'windows_long_paths_enabled') as registry, \
                        patch.object(Path, 'mkdir') as mkdir, patch.object(Path, 'open') as opened:
                    path_check.check_windows_source_paths(self.state, unexpected_paths(), probe=probe)
                registry.assert_not_called()
                mkdir.assert_not_called()
                opened.assert_not_called()
        self.assertEqual(list(self.state.iterdir()), [])

    def test_windows_check_preserves_output_encoding_and_handles_unicode_paths(self):
        for encoding in ('utf-8', 'gbk', 'cp1252', 'ascii'):
            for name in ('new-service', '中文 路径', '新实例 \U0001f680'):
                self.state = self.root / name
                raw_output, raw_errors = io.BytesIO(), io.BytesIO()
                with self.subTest(encoding=encoding, path=name), \
                        io.TextIOWrapper(raw_output, encoding=encoding) as output, \
                        io.TextIOWrapper(raw_errors, encoding=encoding) as errors:
                    with patch.object(sys, 'platform', 'win32'), \
                            patch.object(start, 'check_source_checkout'), \
                            patch.object(start, 'dependency_report'), \
                            patch.object(start, 'source_copy_targets', return_value=[self.relative_target(265)]), \
                            patch.object(path_check, 'windows_long_paths_enabled', return_value=False), \
                            patch.object(start, 'initialize') as initialize, \
                            redirect_stdout(output), redirect_stderr(errors):
                        result = start.main(['--check', '--data-dir', str(self.state)])
                    output.flush()
                    errors.flush()
                    message = raw_output.getvalue().decode(encoding)
                    self.assertEqual(result, 0)
                    self.assertIn('read-only', message)
                    self.assertIn('Windows long-path limits', message)
                    self.assertIn(str(self.state).encode(encoding, errors='backslashreplace').decode(encoding), message)
                    if encoding == 'utf-8':
                        self.assertIn('源文件最长目标路径', message)
                        self.assertIn(str(self.state), message)
                    for stream in (output, errors):
                        self.assertEqual(stream.encoding, encoding)
                        self.assertEqual(stream.errors, 'backslashreplace')
                    self.assertEqual(raw_errors.getvalue(), b'')
                    initialize.assert_not_called()
                    self.assertFalse(self.state.exists())

    def test_windows_error_diagnostic_remains_readable_in_legacy_encodings(self):
        self.state = self.root / '中文 路径 \U0001f680'
        failure = path_check.WindowsPathError(f'长路径不可用 / Long paths unavailable: {self.state}')
        for encoding in ('utf-8', 'gbk', 'cp1252', 'ascii'):
            raw_output, raw_errors = io.BytesIO(), io.BytesIO()
            with self.subTest(encoding=encoding), \
                    io.TextIOWrapper(raw_output, encoding=encoding) as output, \
                    io.TextIOWrapper(raw_errors, encoding=encoding) as errors:
                with patch.object(sys, 'platform', 'win32'), \
                        patch.object(start, 'check_source_checkout'), patch.object(start, 'dependency_report'), \
                        patch.object(start, 'source_copy_targets', return_value=()), \
                        patch.object(start, 'check_windows_source_paths', side_effect=failure), \
                        redirect_stdout(output), redirect_stderr(errors):
                    result = start.main(['--check', '--data-dir', str(self.state)])
                errors.flush()
                message = raw_errors.getvalue().decode(encoding)
                self.assertEqual(result, 1)
                self.assertIn('SoduWork could not start', message)
                self.assertIn(str(failure).encode(encoding, errors='backslashreplace').decode(encoding), message)
                self.assertEqual(errors.encoding, encoding)
                self.assertEqual(errors.errors, 'backslashreplace')
                self.assertFalse(self.state.exists())

    def test_nonwindows_check_preserves_stream_encoding_and_error_policy(self):
        for platform in ('linux', 'darwin'):
            with self.subTest(platform=platform), \
                    io.TextIOWrapper(io.BytesIO(), encoding='cp1252', errors='strict') as output, \
                    io.TextIOWrapper(io.BytesIO(), encoding='cp1252', errors='strict') as errors:
                with patch.object(sys, 'platform', platform), \
                        patch.object(start, 'check_source_checkout'), patch.object(start, 'dependency_report'), \
                        redirect_stdout(output), redirect_stderr(errors):
                    self.assertEqual(start.main(['--check', '--data-dir', str(self.state)]), 0)
                for stream in (output, errors):
                    self.assertEqual(stream.encoding, 'cp1252')
                    self.assertEqual(stream.errors, 'strict')

    def test_prepare_checks_paths_before_copy_caches_venv_or_downloads(self):
        failure = path_check.WindowsPathError('path preflight failed')
        with patch.object(build, 'check_windows_source_paths', side_effect=failure) as check, \
                patch.object(build, 'check_dependencies') as dependencies, \
                patch.object(build, 'prepare_environment') as caches, \
                patch.object(build, 'sync_source') as sync, \
                patch.object(build.shutil, 'copyfile') as copy, patch.object(build, 'run') as run:
            with self.assertRaises(path_check.WindowsPathError) as raised:
                build.prepare(self.state, self.state / 'startup.log')
        self.assertIs(raised.exception, failure)
        self.assertEqual(check.call_args.args[0], self.state)
        self.assertTrue(check.call_args.kwargs['probe'])
        for operation in (dependencies, caches, sync, copy, run):
            operation.assert_not_called()
        self.assertEqual(list(self.state.iterdir()), [])

    def test_projection_matches_copied_source_and_ignores_missing_or_excluded_files(self):
        source = self.root / 'checkout'
        copied = (
            'hub-backend/app/main.py', 'hub-backend/migrations/versions/0002_example.py',
            'hub-backend/requirements.txt', 'client/core/model.js', 'skills/example/SKILL.md',
            'third-party/manifest.json', 'hub-frontend/src/main.jsx', 'hub-frontend/index.html',
            'LICENSE',
        )
        excluded = (
            'hub-backend/tests/test_unrelated.py', 'client/node_modules/example/index.js',
            'client/.env', 'client/private.db', 'client/__pycache__/cached.pyc',
            'hub-frontend/node_modules/vite/index.js',
        )
        for name in (*copied, *excluded, 'tools/dev/local_server.py'):
            file = source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'public test fixture')
        with patch.object(build, 'ROOT', source), patch.object(build, 'checkout_files', return_value=None):
            projected = set(build.source_copy_targets())
        expected = {Path('application') / name for name in copied}
        expected.add(Path('application/hub-backend/_soduwork_source_server.py'))
        self.assertEqual(projected, expected)

    def test_missing_source_keeps_original_copy_error_without_starting_installs(self):
        source = self.root / 'missing-checkout'
        source.mkdir()
        with patch.object(sys, 'platform', 'win32'), patch.object(build, 'ROOT', source), \
                patch.object(build, 'checkout_files', return_value=None), \
                patch.object(build, 'check_dependencies', return_value=('node', 'npm')), \
                patch.object(build, 'run') as run:
            with self.assertRaises(FileNotFoundError) as raised:
                build.prepare(self.state, self.state / 'startup.log')
        self.assertEqual(Path(raised.exception.filename), source / 'hub-backend' / build.BACKEND_FILES[0])
        self.assertNotIsInstance(raised.exception, path_check.WindowsPathError)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
