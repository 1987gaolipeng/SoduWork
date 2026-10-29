"""Non-development deployments require explicitly configured strong credentials."""
import unittest
from app.config import Settings


class SecurityConfigTests(unittest.TestCase):
    def settings(self, **overrides):
        values = dict(database_url="postgresql+asyncpg://user@localhost/fixture",
                      soduwork_env="production", admin_pass="a" * 16, auth_secret="b" * 32,
                      cors_origins="https://hub.example.invalid", device_auth_compat=False,
                      hub_public_url="https://hub.example.invalid")
        values.update(overrides)
        return Settings(_env_file=None, **values)

    def test_explicit_credentials_are_accepted(self):
        self.settings().validate_security()

    def test_short_or_empty_credentials_are_rejected(self):
        for field, minimum in (("admin_pass", 16), ("auth_secret", 32)):
            for value in ("", "x" * (minimum - 1)):
                with self.subTest(field=field, length=len(value)):
                    with self.assertRaisesRegex(RuntimeError, field):
                        self.settings(**{field: value}).validate_security()

    def test_production_does_not_generate_credentials(self):
        settings = self.settings(admin_pass="", auth_secret="")
        settings.resolve_secrets()
        self.assertEqual(settings.admin_pass, "")
        self.assertEqual(settings.auth_secret, "")
        with self.assertRaises(RuntimeError):
            settings.validate_security()

    def test_local_development_remains_available(self):
        self.settings(database_url="sqlite+aiosqlite:///:memory:", soduwork_env="development",
                      admin_pass="", auth_secret="").validate_security()


if __name__ == "__main__":
    unittest.main()
