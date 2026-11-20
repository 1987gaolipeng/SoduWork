"""Database checks for desktop replacement without revoking phones or cloud jobs."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.db import Base
from app.models import Client, User
from app.automation_models import RunnerNode
from app.services import desktop_login_policy as policy


class DesktopLoginTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda db: Base.metadata.create_all(db, tables=[User.__table__, Client.__table__, RunnerNode.__table__]))
        async with self.sessions() as session:
            session.add_all([User(id="one", username="one", is_active=True), User(id="two", username="two", is_active=True)])
            for identity, platform, owner in [("new", "win32", "one"), ("old", "Windows", "one"),
                ("phone", "android", "one"), ("cloud", "linux", "one"), ("foreign", "win32", "two")]:
                session.add(Client(id=identity, name=identity, platform=platform, user_ref=owner, auth_state="active", auth_version=1))
            session.add(RunnerNode(id="cloud-runner", client_id="cloud", owner_user_id="one"))
            await session.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_new_desktop_revokes_only_previous_desktop_and_keeps_provenance(self):
        async with self.sessions() as session:
            client = await session.get(Client, "new")
            user = SimpleNamespace(id="one")
            await policy.lock_devices(session, client, user)
            self.assertEqual(await policy.replace_previous(session, client, user), ["old"])
            await session.commit()
        async with self.sessions() as session:
            old = await session.get(Client, "old")
            self.assertEqual((old.auth_state, old.auth_version, old.user_ref), ("pending", 2, "one"))
            for identity in ("new", "phone", "cloud", "foreign"):
                self.assertEqual((await session.get(Client, identity)).auth_state, "active")

    async def test_phone_and_cloud_login_do_not_replace_desktop(self):
        async with self.sessions() as session:
            for identity in ("phone", "cloud"):
                client = await session.get(Client, identity)
                self.assertEqual(await policy.replace_previous(session, client, SimpleNamespace(id="one")), [])
            await session.commit()
            self.assertEqual((await session.get(Client, "old")).auth_state, "active")

    async def test_desktop_reporting_arch_suffix_replaces_previous_desktop(self):
        # Desktop clients report "<os>/<arch>"; Client.platform stores that string
        # verbatim, so the arch suffix must not stop a previous desktop signing out.
        async with self.sessions() as session:
            session.add(User(id="three", username="three", is_active=True))
            for identity, platform in (("old-arm", "darwin/arm64"), ("new-arm", "darwin/arm64")):
                session.add(Client(id=identity, name=identity, platform=platform,
                                   user_ref="three", auth_state="active", auth_version=1))
            await session.commit()
        async with self.sessions() as session:
            client = await session.get(Client, "new-arm")
            self.assertEqual(await policy.replace_previous(session, client, SimpleNamespace(id="three")), ["old-arm"])
            await session.commit()
        async with self.sessions() as session:
            previous = await session.get(Client, "old-arm")
            self.assertEqual((previous.auth_state, previous.auth_version), ("pending", 2))

    async def test_arch_suffixed_platform_still_matches_for_linux(self):
        async with self.sessions() as session:
            session.add(User(id="four", username="four", is_active=True))
            for identity in ("old-linux2", "new-linux2"):
                session.add(Client(id=identity, name=identity, platform="linux/x64",
                                   user_ref="four", auth_state="active", auth_version=1))
            await session.commit()
        async with self.sessions() as session:
            client = await session.get(Client, "new-linux2")
            self.assertEqual(await policy.replace_previous(session, client, SimpleNamespace(id="four")),
                             ["old-linux2"])
            await session.commit()

    async def test_arch_suffixed_phone_platform_is_not_treated_as_desktop(self):
        async with self.sessions() as session:
            session.add(Client(id="desk", name="desk", platform="linux/x64",
                               user_ref="one", auth_state="active", auth_version=1))
            await session.commit()
        async with self.sessions() as session:
            client = await session.get(Client, "phone")
            client.platform = "android/arm64"
            await session.commit()
        async with self.sessions() as session:
            client = await session.get(Client, "phone")
            self.assertEqual(await policy.replace_previous(session, client, SimpleNamespace(id="one")), [])
            await session.commit()
        async with self.sessions() as session:
            self.assertEqual((await session.get(Client, "desk")).auth_state, "active")

    async def test_administrative_assignment_cannot_bypass_desktop_replacement(self):
        from app.api import admin
        for endpoint in (admin.assign_client, admin.activate_client):
            async with self.sessions() as session:
                user = await session.get(User, "one")
                current = await session.get(Client, "new")
                current.secret_hash = "isolated-existing-key-hash"
                old = await session.get(Client, "old")
                old.auth_state = "active"
                await session.commit()
                with patch.object(admin, "_assert_client_in_scope", AsyncMock()), \
                     patch.object(admin, "_assert_user_in_scope", AsyncMock()), \
                     patch.object(admin.audit, "log", AsyncMock()), \
                     patch.object(admin.device_connections, "disconnect", AsyncMock()) as disconnect:
                    response = await endpoint("new", SimpleNamespace(userId="one"), user, session)
                    self.assertTrue(response["ok"])
                    disconnect.assert_any_await("old", 4401)
                await session.refresh(old)
                self.assertEqual((old.auth_state, old.user_ref), ("pending", "one"))
                for identity in ("phone", "cloud", "foreign"):
                    self.assertEqual((await session.get(Client, identity)).auth_state, "active")

    async def assert_platform_replacement(self, old_platform, new_platform, expected):
        """Use a fresh transaction for each pair and read both devices back from the database."""
        async with self.sessions() as session:
            old = await session.get(Client, "old")
            new = await session.get(Client, "new")
            old.platform, new.platform = old_platform, new_platform
            await session.flush()
            replaced = await policy.replace_previous(session, new, SimpleNamespace(id="one"))
            await session.refresh(old)
            await session.refresh(new)
            self.assertEqual(replaced, ["old"] if expected else [])
            self.assertEqual((old.auth_state, old.auth_version), ("pending", 2) if expected else ("active", 1))
            self.assertEqual((new.auth_state, new.auth_version), ("active", 1))

    async def test_windows_bare_and_arch_replacement(self):
        """Cover Windows arch-to-arch and both directions of a mixed-format login."""
        for old, new in (("win32/x64", "win32/x64"), ("win32", "win32/x64"), ("win32/x64", "win32")):
            with self.subTest(old=old, new=new):
                await self.assert_platform_replacement(old, new, True)

    async def test_platform_whitespace_matches_in_both_directions(self):
        """Use each input as a new login and as an existing record against a known desktop."""
        cases = (
            (" WIN32 ", True), ("win32 /x64", True), ("\tLinux\r\n/arm64 ", True),
            ("android/arm64", False), ("win32x/x64", False), ("win 32/x64", False),
            ("", False), (" \t\n", False),
        )
        for platform, expected in cases:
            for old, new in ((platform, "win32"), ("win32", platform)):
                with self.subTest(old=old, new=new):
                    await self.assert_platform_replacement(old, new, expected)


if __name__ == "__main__":
    unittest.main()
