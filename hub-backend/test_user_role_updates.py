"""User role updates persist and immediately affect existing authenticated sessions."""
import asyncio
import importlib
import os
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", secrets.token_hex(32))
os.environ.setdefault("ADMIN_PASS", secrets.token_hex(16))

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import sign_token
from app.db import Base, get_session

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class AdminUserTestCase(unittest.IsolatedAsyncioTestCase):
    database_url = "sqlite+aiosqlite:///:memory:"

    async def asyncSetUp(self):
        self.engine = create_async_engine(self.database_url)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="team", name="Team"),
                models.OrgUnit(id="child", name="Child", parent_id="team"),
                models.OrgUnit(id="outside", name="Outside"),
                models.Role(id="manager", name="Manager", permissions=["user.manage"]),
                models.Role(id="reader", name="Reader", permissions=["task.view"]),
            ])
            for uid, org, role in (("actor", "team", "manager"),
                                   ("target", "child", "manager"),
                                   ("outsider", "outside", "manager"),
                                   ("reader", "team", "reader")):
                session.add(models.User(
                    id=uid, username=uid, display_name=uid, org_id=org, role_id=role,
                    is_active=True, auth_version=1,
                    positions=["profession"], domains=["domain"],
                ))
            session.add(models.User(
                id="super", username="super", display_name="Super", org_id="team",
                is_super=True, is_active=True, auth_version=1,
            ))
            await session.commit()

        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://isolated",
        )
        self.tokens = {uid: sign_token(uid, 1)
                       for uid in ("actor", "target", "outsider", "reader", "super")}

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, path, who="actor", **kwargs):
        headers = {"Authorization": "Bearer " + self.tokens[who]} if who else {}
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)


class UserRoleUpdateTests(AdminUserTestCase):
    async def test_user_names_reject_controls_on_create_and_edit(self):
        fields = {"orgId": "team", "username": "member", "password": secrets.token_urlsafe(24)}
        for invalid in ({"displayName": "Jo\x1bAnn"}, {"username": "له\u2066نا"}):
            response = await self.request("POST", "/users", json={**fields, **invalid})
            self.assertEqual(response.status_code, 422, response.text)
        created = await self.request("POST", "/users", json=fields)
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["displayName"], "member")
        path = "/users/" + created.json()["id"]
        for name, expected in (("研发 · ليلى", 200), ("First\nLast", 422)):
            response = await self.request("PATCH", path, json={"displayName": name})
            self.assertEqual(response.status_code, expected, response.text)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.User, created.json()["id"])).display_name, "研发 · ليلى")

    async def test_admin_password_policy_applies_to_create_and_reset(self):
        from app.auth import verify_password
        from app.services import client_access

        for password in ("", "x", "x" * 7, " " * 8, "\u2003" * 12, "x" * 129):
            with self.subTest(length=len(password), blank=not password.strip()):
                for method, path, fields in (("POST", "/users", {"username": "new", "orgId": "team"}),
                                             ("PATCH", "/users/target", {})):
                    response = await self.request(method, path, json={**fields, "password": password})
                    self.assertEqual(response.status_code, 422, response.text)
                with self.assertRaises(client_access.ClientAccessError):
                    client_access.validate_password(password, new_account=True)

        for method, path, fields, password in (
            ("POST", "/users", {"username": "new", "orgId": "team"}, " " + secrets.token_hex(3) + " "),
            ("PATCH", "/users/target", {}, secrets.token_hex(64)),
        ):
            response = await self.request(method, path, json={**fields, "password": password})
            self.assertEqual(response.status_code, 200, response.text)
            async with self.sessions() as session:
                user = await session.get(models.User, response.json()["id"])
                self.assertTrue(verify_password(password, user.password_hash))

    def test_out_of_policy_passwords_are_rejected_before_hash_verification(self):
        from unittest.mock import patch
        from app.auth import verify_password

        with patch("app.auth.hashlib.pbkdf2_hmac") as derive:
            for password in ("", "x" * 7, "\t" * 8, "\u2003" * 12, "x" * 129):
                with self.subTest(length=len(password)):
                    self.assertFalse(verify_password(password, "pbkdf2$200000$abcd$abcd"))
            derive.assert_not_called()

    async def test_builtin_role_is_read_only_and_catalog_explains_permissions(self):
        async with self.sessions() as session:
            session.add(models.Role(id="builtin", name="System role", is_system=True, permissions=["task.view"]))
            await session.commit()
        for patch in ({"name": "Other name"}, {"permissions": []}):
            result = await self.request("PATCH", "/roles/builtin", who="super", json=patch)
            self.assertEqual(result.status_code, 400, result.text)
        catalog = await self.request("GET", "/permissions", who="super")
        self.assertEqual(catalog.status_code, 200)
        self.assertTrue(catalog.json())
        for permission in catalog.json():
            self.assertTrue(permission["description"])
            self.assertIn(permission["risk"], ("low", "medium", "high"))

    async def assert_stored_role(self, uid, expected):
        async with self.sessions() as session:
            user = await session.get(models.User, uid)
            self.assertEqual(user.role_id, expected)

    async def test_explicit_null_clears_role_in_response_list_database_and_audit(self):
        updated = await self.request("PATCH", "/users/target", json={"roleId": None})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertIsNone(updated.json()["roleId"])
        listed = await self.request("GET", "/users")
        self.assertEqual(listed.status_code, 200, listed.text)
        target = next(user for user in listed.json() if user["id"] == "target")
        self.assertIsNone(target["roleId"])
        await self.assert_stored_role("target", None)
        async with self.sessions() as session:
            audit = (await session.execute(select(models.AuditLog).where(
                models.AuditLog.action == "user.update",
                models.AuditLog.target_id == "target",
            ))).scalars().one()
            self.assertEqual(audit.actor_id, "actor")
            self.assertEqual(audit.detail["fields"], ["roleId"])
            self.assertFalse(audit.detail["pwChanged"])

    async def test_omitted_role_keeps_existing_role(self):
        updated = await self.request("PATCH", "/users/target", json={"displayName": "Renamed"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["displayName"], "Renamed")
        self.assertEqual(updated.json()["roleId"], "manager")
        await self.assert_stored_role("target", "manager")

    async def test_explicit_account_type_survives_older_clients_and_can_be_cleared(self):
        response = await self.request("POST", "/users", json={
            "username": "fixture-member", "password": secrets.token_urlsafe(24),
            "orgId": "team", "isTestAccount": True,
        })
        self.assertEqual(response.status_code, 200, response.text)
        path = "/users/" + response.json()["id"]
        self.assertIs(response.json()["isTestAccount"], True)
        for patch, expected in (({"displayName": "Member"}, True), ({"isTestAccount": False}, False),
                                ({"isTestAccount": None}, None)):
            response = await self.request("PATCH", path, json=patch)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIs(response.json()["isTestAccount"], expected)

    async def test_role_can_be_replaced_and_assigned_after_clearing(self):
        for role_id in ("reader", None, "manager"):
            with self.subTest(role_id=role_id):
                updated = await self.request("PATCH", "/users/target", json={"roleId": role_id})
                self.assertEqual(updated.status_code, 200, updated.text)
                self.assertEqual(updated.json()["roleId"], role_id)
                await self.assert_stored_role("target", role_id)

    async def test_existing_token_loses_permissions_after_role_is_cleared(self):
        allowed = await self.request("GET", "/users", who="target")
        self.assertEqual(allowed.status_code, 200, allowed.text)
        previous_me = await self.request("GET", "/me", who="target")
        self.assertEqual(previous_me.json()["permissions"], ["user.manage"])

        updated = await self.request("PATCH", "/users/target", json={"roleId": None})
        self.assertEqual(updated.status_code, 200, updated.text)
        # request() reuses the exact token issued in setUp, without logging in again.
        current_me = await self.request("GET", "/me", who="target")
        self.assertEqual(current_me.status_code, 200, current_me.text)
        self.assertIsNone(current_me.json()["roleId"])
        self.assertEqual(current_me.json()["permissions"], [])
        denied = await self.request("GET", "/users", who="target")
        self.assertEqual(denied.status_code, 403, denied.text)
        denied = await self.request("PATCH", "/users/target", who="target",
                                    json={"roleId": "manager"})
        self.assertEqual(denied.status_code, 403, denied.text)
        await self.assert_stored_role("target", None)

    async def test_other_null_fields_keep_existing_values(self):
        updated = await self.request("PATCH", "/users/target", json={
            "roleId": None, "displayName": None, "orgId": None, "isActive": None,
            "positions": None, "domains": None, "password": None, "tokenQuota": None,
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        async with self.sessions() as session:
            target = await session.get(models.User, "target")
            self.assertIsNone(target.role_id)
            self.assertEqual(target.display_name, "target")
            self.assertEqual(target.org_id, "child")
            self.assertTrue(target.is_active)
            self.assertEqual(target.positions, ["profession"])
            self.assertEqual(target.domains, ["domain"])
            self.assertEqual(target.password_hash, "")
            self.assertEqual(target.auth_version, 1)

    async def test_empty_string_still_clears_role(self):
        updated = await self.request("PATCH", "/users/target", json={"roleId": ""})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertIsNone(updated.json()["roleId"])
        await self.assert_stored_role("target", None)

    async def test_role_update_keeps_authentication_permission_and_scope_guards(self):
        for who, uid, expected in ((None, "target", 401),
                                   ("reader", "target", 403),
                                   ("actor", "outsider", 403)):
            with self.subTest(who=who, uid=uid):
                denied = await self.request("PATCH", "/users/" + uid, who=who,
                                            json={"roleId": None})
                self.assertEqual(denied.status_code, expected, denied.text)
                await self.assert_stored_role(uid, "manager")
        denied = await self.request("PATCH", "/users/target",
                                    json={"roleId": None, "orgId": "outside"})
        self.assertEqual(denied.status_code, 403, denied.text)
        await self.assert_stored_role("target", "manager")

    async def test_superadmin_cannot_be_disabled_when_clearing_role(self):
        denied = await self.request("PATCH", "/users/super", who="super",
                                    json={"roleId": None, "isActive": False})
        self.assertEqual(denied.status_code, 400, denied.text)
        async with self.sessions() as session:
            user = await session.get(models.User, "super")
            self.assertTrue(user.is_active)
            self.assertTrue(user.is_super)
            self.assertEqual(user.auth_version, 1)

    async def test_batch_status_revokes_sessions_once_and_audits_each_change(self):
        async with self.sessions() as session:
            session.add_all([models.Client(id="desktop", user_ref="target", auth_state="active"),
                             models.Client(id="banned", user_ref="target", auth_state="revoked")])
            await session.commit()
        ids = ["target", "reader", "target"]
        with patch.object(admin.device_connections, "disconnect_many") as disconnect:
            for active, count in ((False, 2), (False, 0), (True, 2)):
                result = await self.request("POST", "/users/batch", json={"ids": ids, "isActive": active})
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(result.json(), {"updated": count})
                self.assertEqual((await self.request("GET", "/me", who="target")).status_code, 401)
            disconnect.assert_awaited_once_with(["desktop"])
        async with self.sessions() as session:
            target = await session.get(models.User, "target")
            self.assertTrue(target.is_active)
            self.assertEqual(target.auth_version, 3)
            for did, expected in (("desktop", ("pending", 2)), ("banned", ("revoked", 1))):
                device = await session.get(models.Client, did)
                self.assertEqual((device.auth_state, device.auth_version), expected)
                self.assertEqual(device.user_ref, "target")
            audits = list(await session.scalars(select(models.AuditLog)))
            self.assertCountEqual([row.target_id for row in audits], ["target", "reader"] * 2)
            self.assertTrue(all(row.action == "user.update" and row.actor_id == "actor" and
                                row.detail == {"fields": ["isActive"], "pwChanged": False} for row in audits))

    async def test_batch_rejects_the_entire_selection(self):
        for who, payload, expected in (
                (None, {"ids": ["target"], "isActive": False}, 401),
                ("reader", {"ids": ["target"], "isActive": False}, 403),
                ("actor", {"ids": ["target", "outsider"], "isActive": False}, 403),
                ("actor", {"ids": ["reader", "actor"], "isActive": False}, 400),
                ("super", {"ids": ["reader", "super"], "isActive": False}, 400),
                ("actor", {"ids": ["reader", "absent"], "isActive": False}, 404),
                ("actor", {"ids": ["target"], "orgId": "outside"}, 403),
                ("super", {"ids": ["target"], "orgId": "absent"}, 400),
                ("actor", {"ids": [], "isActive": True}, 422),
                ("actor", {"ids": ["target"] * 201, "isActive": False}, 422),
                ("actor", {"ids": ["target"], "isActive": False, "orgId": "team"}, 422),
                ("actor", {"ids": ["target"], "roleId": "manager"}, 422)):
            with self.subTest(who=who, status=expected):
                denied = await self.request("POST", "/users/batch", who=who, json=payload)
                self.assertEqual(denied.status_code, expected, denied.text)
        async with self.sessions() as session:
            for target in await session.scalars(select(models.User)):
                self.assertTrue(target.is_active)
                self.assertEqual(target.auth_version, 1)
            self.assertIsNone(await session.scalar(select(models.AuditLog.id)))

    async def test_batch_department_requires_compatible_professions_and_preserves_sessions(self):
        ids = ["reader", "target"]
        async with self.sessions() as session:
            session.add(models.Position(id="profession", name="QA", org_id="child"))
            await session.commit()
        denied = await self.request("POST", "/users/batch", json={"ids": ids, "orgId": "team"})
        self.assertEqual(denied.status_code, 400, denied.text)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.User, "target")).org_id, "child")
            self.assertIsNone(await session.scalar(select(models.AuditLog.id)))
            profession = await session.get(models.Position, "profession")
            profession.org_id = "team"
            await session.commit()
        for expected in (1, 0):
            result = await self.request("POST", "/users/batch", json={"ids": ids, "orgId": "team"})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json(), {"updated": expected})
        me = await self.request("GET", "/me", who="target")
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(me.json()["orgId"], "team")
        self.assertEqual(me.json()["positions"], ["profession"])


class UserDepartmentConcurrencyTests(AdminUserTestCase):
    async def asyncSetUp(self):
        database = tempfile.TemporaryDirectory()
        self.addCleanup(database.cleanup)
        self.database_url = "sqlite+aiosqlite:///" + (Path(database.name) / "users.db").as_posix()
        await super().asyncSetUp()

    async def test_department_deletion_waits_for_individual_user_assignments(self):
        async with self.sessions() as session:
            session.add(models.Position(id="profession", name="QA"))
            session.add_all([models.OrgUnit(id="new-hire", name="New hire"),
                             models.OrgUnit(id="transfer", name="Transfer")])
            await session.commit()
        check_org, lock_tree = admin._require_existing_org, admin.rbac.lock_org_tree
        for method, path, payload in (
                ("POST", "/users", {"username": "hire", "password": secrets.token_urlsafe(24), "orgId": "new-hire"}),
                ("PATCH", "/users/target", {"orgId": "transfer"})):
            org_id = payload["orgId"]
            shared_lock, checked, deleting = asyncio.Event(), asyncio.Event(), asyncio.Event()

            async def pause_after_validation(session, oid):
                # SQLite also takes a writer lock on users. PostgreSQL needs the explicit tree lock here.
                self.assertTrue(shared_lock.is_set())
                await check_org(session, oid)
                checked.set()
                await asyncio.wait_for(deleting.wait(), 10)

            async def observe_delete(session, *, shared=False):
                if not shared:
                    deleting.set()
                await lock_tree(session, shared=shared)
                if shared:
                    shared_lock.set()

            async def delete_after_validation():
                await asyncio.wait_for(checked.wait(), 10)
                return await self.request("DELETE", "/orgs/" + org_id, who="super")

            with patch.object(admin, "_require_existing_org", pause_after_validation), \
                    patch.object(admin.rbac, "lock_org_tree", observe_delete):
                saved, deleted = await asyncio.gather(
                    self.request(method, path, who="super", json=payload), delete_after_validation())
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(deleted.status_code, 400, deleted.text)
            self.assertEqual(deleted.headers["X-Error-Code"], "org.delete.has_users")
            async with self.sessions() as session:
                self.assertIsNotNone(await session.get(models.OrgUnit, org_id))
                self.assertEqual((await session.get(models.User, saved.json()["id"])).org_id, org_id)


if __name__ == "__main__":
    unittest.main()
