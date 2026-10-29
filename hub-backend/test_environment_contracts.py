"""Declarative configuration remains safe and probe identities remain exact."""
import copy
import os
from types import SimpleNamespace as Row
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import environment_contracts as contracts, environment_service


class EnvironmentContractsTests(unittest.TestCase):
    def test_target_and_health_checks_keep_their_canonical_shape(self):
        raw = {"argv": ["deploy", "release"], "timeoutSeconds": 99999,
               "env": {"MODE": "staging"}, "cwd": "/ignored/private",
               "clientReleaseUpload": {"enabled": True, "baseUrl": "https://fixture.invalid/"}}
        original = copy.deepcopy(raw)
        expected = {"argv": ["deploy", "release"], "timeoutSeconds": 3600,
                    "env": {"MODE": "staging"}, "cwd": "repo",
                    "clientReleaseUpload": {"enabled": True, "baseUrl": "https://fixture.invalid"}}
        self.assertEqual(contracts._target_config(raw), expected)
        self.assertEqual(environment_service._target_config(raw), expected)
        self.assertEqual(raw, original)
        checks = [{"type": "http", "url": "https://fixture.invalid/ready", "method": "get",
                   "contains": "ready", "retries": 99},
                  {"type": "command", "argv": ["check"], "timeoutSeconds": 999},
                  {"type": "screenshot", "url": "https://fixture.invalid/"}]
        actual = contracts._checks(checks)
        self.assertEqual((actual[0]["method"], actual[0]["retries"], actual[0]["intervalSeconds"]),
                         ("GET", 10, 5))
        self.assertEqual(actual[1]["timeoutSeconds"], 120)
        self.assertTrue(actual[2]["required"])

    def test_credential_and_unstructured_command_guards_are_preserved(self):
        for raw in ({"argv": "deploy release"},
                    {"argv": ["deploy"], "env": {"API_TOKEN": "fixture"}},
                    {"argv": ["deploy"], "clientReleaseUpload": {"baseUrl": "https://user:pass@fixture.invalid"}}):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                contracts._target_config(raw)

    def test_rollback_and_probe_fingerprint_bind_exact_effective_configuration(self):
        env = Row(rollback={"mode": "automatic", "argv": ["rollback"]},
                  runner_selector={"tags": ["staging"]}, health_checks=[])
        target = Row(provider="runner-command", repo_id="repo", config={"argv": ["deploy"]},
                     secret_refs={"TOKEN": "ref"}, runner_selector={}, health_checks=[],
                     rollback={"mode": "manual"})
        repo = Row(id="repo", git_url="https://fixture.invalid/repo.git", merge_branch="main",
                   default_branch="main")
        ref = Row(provider="runner-env", locator="FIXTURE_TOKEN", enabled=True)
        self.assertEqual(contracts.effective_rollback(env, target),
                         {"mode": "automatic", "argv": ["rollback"]})
        fingerprint = contracts.target_probe_fingerprint(target, env, repo, {"ref": ref})
        self.assertEqual(fingerprint, environment_service.target_probe_fingerprint(
            target, env, repo, {"ref": ref}))
        ref.enabled = False
        self.assertNotEqual(fingerprint, contracts.target_probe_fingerprint(target, env, repo, {"ref": ref}))
        ref.enabled = True
        target.config["argv"] = ["deploy", "changed"]
        self.assertNotEqual(fingerprint, contracts.target_probe_fingerprint(target, env, repo, {"ref": ref}))


if __name__ == "__main__":
    unittest.main()
