"""GitLab credential selection never silently verifies a different account."""
import io
import json
import unittest
import urllib.error
from unittest.mock import Mock, patch

from app.config import Settings
from app.connectors.gitlab import GitLabConnector


class Reply(io.BytesIO):
    status = 200

    def __init__(self, body):
        super().__init__(body)


class GitLabAuthTests(unittest.TestCase):
    def setUp(self):
        self.settings = Settings(_env_file=None, admin_pass="fixture-only-password",
            auth_secret="fixture-only-auth-secret", gitlab_token="global-token")
        self.patch = patch("app.connectors.gitlab.get_settings", return_value=self.settings)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.connector = GitLabConnector()
        self.cfg = {"base_url": "https://gitlab.example.test", "token": "old-config-token",
            "_auth_user": "chosen-user", "_auth_secret": "chosen-secret"}

    def test_selected_password_wins_over_old_tokens(self):
        opener = Mock()
        with patch.object(self.connector, "_ldap_login") as login:
            self.assertEqual(self.connector._api_headers({**self.cfg, "_auth_kind": "password"}, opener), {})
        login.assert_called_once_with(self.cfg["base_url"], opener, "chosen-user", "chosen-secret")
        opener.open.assert_not_called()

    def test_selected_token_does_not_probe_or_attempt_password_login(self):
        opener = Mock()
        with patch.object(self.connector, "_ldap_login") as login:
            result = self.connector._api_headers({**self.cfg, "_auth_kind": "token"}, opener)
        self.assertEqual(result, {"PRIVATE-TOKEN": "chosen-secret"})
        login.assert_not_called()
        opener.open.assert_not_called()

    def test_auto_selected_account_uses_its_own_secret(self):
        opener = Mock()
        opener.open.return_value = Reply(json.dumps({"id": 1, "username": "chosen-user"}).encode())
        self.assertEqual(self.connector._api_headers(self.cfg, opener), {"PRIVATE-TOKEN": "chosen-secret"})
        self.assertEqual(opener.open.call_args.args[0].get_header("Private-token"), "chosen-secret")

    def test_auto_only_falls_back_on_unauthorized(self):
        for status in [401, 403, 429, 503]:
            with self.subTest(status=status):
                opener = Mock()
                opener.open.side_effect = urllib.error.HTTPError("secret-url", status, "secret-message", {}, None)
                with patch.object(self.connector, "_ldap_login") as login:
                    if status == 401:
                        self.assertEqual(self.connector._api_headers(self.cfg, opener), {})
                        login.assert_called_once()
                    else:
                        with self.assertRaises(ValueError) as caught:
                            self.connector._api_headers(self.cfg, opener)
                        self.assertIn(str(status), str(caught.exception))
                        self.assertNotIn("secret", str(caught.exception))
                        login.assert_not_called()

    def test_network_failure_does_not_submit_secret_as_password(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError("secret-proxy-url")
        with patch.object(self.connector, "_ldap_login") as login:
            with self.assertRaises(ValueError) as caught:
                self.connector._api_headers(self.cfg, opener)
        login.assert_not_called()
        self.assertNotIn("secret", str(caught.exception))

    def test_html_success_response_is_not_authenticated_user(self):
        opener = Mock()
        opener.open.return_value = Reply(b"<html>sign in</html>")
        with patch.object(self.connector, "_ldap_login") as login:
            with self.assertRaises(ValueError):
                self.connector._api_headers(self.cfg, opener)
        login.assert_not_called()

    def test_old_token_configuration_remains_usable_without_selected_account(self):
        self.assertEqual(self.connector._api_headers({"token": "explicit-token"}, Mock()),
                         {"PRIVATE-TOKEN": "explicit-token"})
        self.assertEqual(self.connector._api_headers({}, Mock()), {"PRIVATE-TOKEN": "global-token"})


if __name__ == "__main__":
    unittest.main()
