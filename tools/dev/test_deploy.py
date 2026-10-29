"""Safety and restart contracts of the public single-host entry."""
import base64
import io
import subprocess
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from tools.dev import deploy

class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-deploy-test-")
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "private"

    def test_first_install_private_random_secrets_and_stable_project(self):
        first = deploy.initialize(self.state, create=True, port=18991, origin=None)
        again = deploy.initialize(self.state, create=True, port=None, origin=None)
        self.assertEqual(first, again)
        self.assertEqual(first["publicUrl"], "http://127.0.0.1:18991")
        self.assertEqual(len(base64.urlsafe_b64decode(first["oauthKey"])), 32)
        other = deploy.initialize(Path(self.temp.name) / "other", create=True, port=None, origin=None)
        for key in (*deploy.SECRET_KEYS, "project"):
            self.assertNotEqual(first[key], other[key])
        self.assertNotIn(first["adminPassword"], str(deploy.compose_command("docker", self.state, first)))

    def test_unrelated_data_and_corrupt_settings_not_overwritten(self):
        self.state.mkdir()
        file = self.state / "business.txt"
        file.write_text("preserve", encoding="utf-8")
        with self.assertRaisesRegex(deploy.StartupError, "not empty"):
            deploy.initialize(self.state, create=True, port=None, origin=None)
        self.assertEqual(file.read_text(), "preserve")
        (self.state / "deployment.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(deploy.StartupError, "restore"):
            deploy.initialize(self.state, create=True, port=None, origin=None)
        self.assertEqual((self.state / "deployment.json").read_text(), "{}")

    def test_existing_settings_cannot_silently_switch_endpoint(self):
        deploy.initialize(self.state, create=True, port=None, origin=None)
        with self.assertRaisesRegex(deploy.StartupError, "already exists"):
            deploy.initialize(self.state, create=True, port=19000, origin=None)
        with self.assertRaisesRegex(deploy.StartupError, "already exists"):
            deploy.initialize(self.state, create=True, port=None, origin="https://other.example")

    def test_public_endpoint_only_origin_and_https_except_loopback(self):
        for value in ("http://remote.example", "https://user:secret@example.com", "https://example.com/api",
                      "https://example.com?token=secret", "https://example.com#x", "https://example.com:bad"):
            with self.subTest(value=value), self.assertRaises(deploy.StartupError):
                deploy.public_url(value, 18989)
        self.assertEqual(deploy.public_url("https://team.example/", 18989), "https://team.example")
        self.assertEqual(deploy.public_url("http://localhost:18989", 18989), "http://localhost:18989")

    def test_env_cannot_redirect_project_or_database(self):
        config = deploy.initialize(self.state, create=True, port=None, origin=None)
        with patch.dict(os.environ, {"COMPOSE_FILE": "private-production.yaml", "DATABASE_URL": "production",
                                     "SODUWORK_DB_PASSWORD": "wrong", "HTTPS_PROXY": "permitted-proxy"}):
            env = deploy.environment(config)
        self.assertNotIn("COMPOSE_FILE", env)
        self.assertNotIn("DATABASE_URL", env)
        self.assertEqual(env["SODUWORK_DB_PASSWORD"], config["databasePassword"])
        self.assertEqual(env["HTTPS_PROXY"], "permitted-proxy")
        args = deploy.compose_command("docker", self.state, config)
        self.assertIn("--env-file", args)
        self.assertEqual(args[-1], "-")
        self.assertIn(str(deploy.COMPOSE.parent), args)

    def test_remote_docker_is_rejected_before_mutation(self):
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://production.example:2376"}), patch.object(deploy.subprocess, "run") as run:
            with self.assertRaisesRegex(deploy.StartupError, "local Docker"):
                deploy.docker_ready("docker")
            run.assert_not_called()

    def test_repository_or_home_cannot_be_instance(self):
        for state in (deploy.ROOT, deploy.ROOT / "runtime", Path.home()):
            with self.assertRaisesRegex(deploy.StartupError, "outside"):
                deploy.state_path(state)

    def test_stop_targets_only_own_project_and_preserves_configuration(self):
        config = deploy.initialize(self.state, create=True, port=None, origin=None)
        before = (self.state / "deployment.json").read_bytes()
        with patch.object(deploy.shutil, "which", return_value="docker"), patch.object(deploy, "docker_ready"), \
                patch.object(deploy.subprocess, "run") as run, patch("sys.stdout", io.StringIO()):
            self.assertEqual(deploy.main(["stop", "--data-dir", str(self.state)]), 0)
        command = run.call_args.args[0]
        self.assertIn(config["project"], command)
        self.assertEqual(command[-3:], ["stop", "--timeout", "45"])
        self.assertNotIn("down", command)
        self.assertEqual((self.state / "deployment.json").read_bytes(), before)

    def test_failed_health_check_reports_failure_and_no_build_does_not_rebuild(self):
        deploy.initialize(self.state, create=True, port=None, origin=None)
        with patch.object(deploy.shutil, "which", return_value="docker"), patch.object(deploy, "docker_ready"), \
                patch.object(deploy.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["docker", "compose"])) as run, \
                patch("sys.stdout", io.StringIO()) as output, patch("sys.stderr", io.StringIO()):
            self.assertEqual(deploy.main(["up", "--no-build", "--data-dir", str(self.state)]), 1)
        self.assertNotIn("is ready", output.getvalue())
        self.assertIn("--no-build", run.call_args.args[0])
        self.assertIn("--wait", run.call_args.args[0])
        self.assertTrue((self.state / "deployment.json").is_file())

    def test_no_existing_instance_created_by_status_or_stop(self):
        with self.assertRaisesRegex(deploy.StartupError, "No self-host"):
            deploy.initialize(self.state, create=False, port=None, origin=None)
        self.assertFalse(self.state.exists())

if __name__ == "__main__":
    unittest.main()
