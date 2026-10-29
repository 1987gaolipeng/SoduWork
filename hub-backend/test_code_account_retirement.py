"""Historical credential storage stays private; GitLab uses its own account."""
from types import SimpleNamespace as NS
import unittest
from app.services import code_creds


class CodeAccountRetirementTests(unittest.TestCase):
    def test_old_password_alone_does_not_claim_push_readiness(self):
        client = NS(git_creds={"name": "Fixture", "email": "fixture@example.test",
                               "gerrit_user": "legacy", "gerrit_token": "fixture-old-password"})
        view = code_creds.api_view(client)
        self.assertFalse(view["pushReady"])
        self.assertTrue(view["gerritTokenSet"])
        self.assertNotIn("fixture-old-password", str(view))
        self.assertNotIn("gerrit_token", code_creds.resolve(client))

    def test_gitlab_edit_keeps_old_storage_but_dispatches_only_active_credentials(self):
        client = NS(git_creds={"gerrit_user": "legacy", "gerrit_token": "fixture-old-password"})
        code_creds.save(client, {"name": "Fixture", "email": "fixture@example.test",
                                 "user": "gitlab-owner", "token": "fixture-active-token"})
        self.assertEqual(client.git_creds["gerrit_token"], "fixture-old-password")
        self.assertTrue(code_creds.api_view(client)["ready"])
        active = code_creds.resolve(client)
        self.assertEqual(active["token"], "fixture-active-token")
        self.assertNotIn("gerrit_user", active)
        env = code_creds.env_for({}, active)
        self.assertEqual(env["SODUWORK_GIT_USER"], "gitlab-owner")
        self.assertEqual(env["SODUWORK_GIT_TOKEN"], "fixture-active-token")
        self.assertNotIn("SODUWORK_GERRIT_TOKEN", env)

    def test_explicit_old_credential_deletion_remains_available(self):
        client = NS(git_creds={"gerrit_user": "legacy", "gerrit_token": "fixture-old-password"})
        code_creds.save(client, {"gerrit_token": None})
        self.assertFalse(code_creds.api_view(client)["gerritTokenSet"])


if __name__ == "__main__":
    unittest.main()
