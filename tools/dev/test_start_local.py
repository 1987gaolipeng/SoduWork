"""Fast contract checks for isolated startup; live verification is a separate script."""
from __future__ import annotations

import io
from contextlib import closing, redirect_stdout
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools.dev import local_environment as build
from tools.dev import start_local as start
from tools.dev import verify_local_start as verify


class LocalStartupTests(unittest.TestCase):
    def test_desktop_restart_ignores_live_historical_ready_events(self):
        journal = self.state / 'desktop-profile/diagnostics/lifecycle.jsonl'
        journal.parent.mkdir(parents=True)
        entries = [{'event': 'ready', 'pid': 100, 'runId': 'older'},
                   {'event': 'ready', 'pid': 200, 'runId': 'previous'}]
        import json
        journal.write_text(''.join(json.dumps(row) + '\n' for row in entries), encoding='utf-8')
        class Child:
            launcher_log = 'isolated launcher fixture'
            def poll(self):
                return None
        def append_ready(_delay):
            with journal.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps({'event': 'ready', 'pid': 300, 'runId': 'new'}) + '\n')
        with patch.object(verify, 'process_alive', return_value=True), \
                patch.object(verify.time, 'sleep', side_effect=append_ready) as slept:
            self.assertEqual(verify.desktop_ready(Child(), self.state, previous_pid=200), 300)
            self.assertEqual(slept.call_count, 1, 'Historical ready entries must not satisfy a restart')

    def test_node_version_matches_runtime_dependency_minimum(self):
        with patch.object(build.shutil, 'which', side_effect=lambda name: name):
            for version in ['v22.18.0', 'v20.20.0']:
                with self.subTest(version=version), patch.object(build.subprocess, 'check_output', return_value=version), \
                        self.assertRaisesRegex(build.StartupError, '22.19'):
                    build.check_dependencies()
            for version in ['v22.19.0', 'v24.18.0']:
                with self.subTest(version=version), patch.object(build.subprocess, 'check_output', return_value=version):
                    self.assertEqual(len(build.check_dependencies()), 2)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-start-unit-")
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "service"

    def test_fresh_source_instance_uses_current_name_but_existing_data_stays(self):
        base = Path(self.temp.name) / "user-data"
        with patch.dict(os.environ, {"LOCALAPPDATA": str(base), "XDG_DATA_HOME": str(base)}):
            if sys.platform == "darwin":
                return  # Native macOS path is covered by its platform startup job.
            fresh = start.default_state()
            self.assertIn("soduwork", fresh.as_posix().lower())
            fresh.mkdir(parents=True)
            marker = fresh / "local-service.json"
            marker.write_text("{}", encoding="utf-8")
            self.assertEqual(start.default_state(), fresh)
            self.assertEqual(marker.read_text(encoding="utf-8"), "{}")

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

    def test_busy_port_is_left_running(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(start.StartupError, "already in use"):
                start.assert_available("127.0.0.1", port)
            self.assertEqual(listener.getsockname()[1], port)

    def test_check_is_read_only_even_for_a_new_data_directory(self):
        with patch.object(start, 'dependency_report') as report, patch.object(start, 'initialize') as initialize:
            self.assertEqual(start.main(['--check', '--desktop', '--data-dir', str(self.state)]), 0)
        report.assert_called_once_with(desktop=True)
        initialize.assert_not_called()
        self.assertFalse(self.state.exists())

    def test_prepare_only_never_requests_password_or_starts_a_server(self):
        with patch.object(start, 'check_dependencies'), patch.object(start, 'prepare') as prepare, \
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
        dockerfile = (build.ROOT / "ops/self-host/Dockerfile.server").read_text(encoding="utf-8")
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
                     "client/assets/connector-brands/fixture.svg", "third-party/manifest.json", "LICENSE",
                     "hub-frontend/src/index.jsx", "hub-frontend/package.json", "hub-frontend/package-lock.json",
                     "hub-frontend/index.html", "hub-frontend/vite.config.js"):
            put(name)
        calls = []
        def run(_command, *, label, **_kwargs):
            calls.append(label)
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
                patch.object(build, "run", side_effect=run):
            build.prepare(self.state, self.state / "startup.log")
            for name in ("LICENSE", "third-party/manifest.json"):
                self.assertEqual((self.state / "application" / name).read_bytes(), (source / name).read_bytes())
            calls.clear()
            put("client/assets/connector-brands/fixture.svg", "updated artwork")
            build.prepare(self.state, self.state / "startup.log")
            self.assertEqual(calls, ["[4/4] 构建管理页面 / Building the management UI"])
            self.assertEqual((self.state / "application/client/assets/connector-brands/fixture.svg").read_text(), "updated artwork")

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


if __name__ == "__main__":
    unittest.main()
