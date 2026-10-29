"""Isolated client sign-in, trusted-device and quota contract smoke."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
import tempfile


_tmp = tempfile.TemporaryDirectory(prefix="soduwork-client-auth-")
_root = Path(_tmp.name)
os.environ["DATABASE_URL"] = (
    "sqlite+aiosqlite:///" + (_root / ".smoke-client-auth.db").as_posix()
)
os.environ["AUTH_SECRET"] = "client-auth-smoke-secret-with-enough-entropy"
os.environ["DEVICE_AUTH_COMPAT"] = "false"

import httpx  # noqa: E402
from sqlalchemy import event  # noqa: E402

from app import automation_models, models, project_context_models  # noqa: E402,F401
from app.auth import hash_password, sign_token  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.services import client_access  # noqa: E402


checks = 0


def ok(value, message: str) -> None:
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


def login_body(device: str, account: str, password: str) -> dict:
    return {
        "device": device,
        "account": account,
        "password": password,
        "displayName": "Smoke Employee",
        "name": "Smoke workstation",
        "platform": "win32",
        "version": "smoke",
        "workRoot": "C:/SoduWork/work",
    }


async def enroll(client: httpx.AsyncClient, device: str, key: str):
    return await client.post(
        "/api/v1/clients/enroll",
        headers={"X-Device-Key": key},
        json={
            "device": device,
            "name": "Smoke workstation",
            "platform": "win32",
            "version": "smoke",
        },
    )


async def login(
    client: httpx.AsyncClient,
    device: str,
    key: str,
    account: str,
    password: str,
):
    return await client.post(
        "/api/v1/client-auth/login",
        headers={"X-Device-Key": key},
        json=login_body(device, account, password),
    )


async def run() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with SessionLocal() as session:
        session.add(models.OrgUnit(id="auth-root", name="SoduWork"))
        session.add(models.User(
            id="auth-admin",
            username="auth-admin",
            password_hash=hash_password("Admin-pass-123"),
            display_name="Auth Admin",
            is_super=True,
            is_active=True,
            auth_version=1,
        ))
        session.add(models.User(username="employee.auth", password_hash=hash_password("Employee-pass-123"),
                                display_name="Smoke Employee", org_id="auth-root", is_active=True))
        await session.commit()

    admin_headers = {
        "Authorization": "Bearer " + sign_token("auth-admin", 1),
    }
    device_1 = "client-auth-device-1"
    device_2 = "client-auth-device-2"
    device_3 = "client-auth-device-3"
    key_1 = "a" * 48
    key_2 = "b" * 48
    key_3 = "c" * 48
    account = "employee.auth"
    password = "Employee-pass-123"
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://soduwork.test",
    ) as client:
        public = await client.get("/api/v1/client-auth/policy")
        ok(public.status_code == 200, "public sign-in policy is unavailable")
        ok(public.json().get("allowSelfRegistration") is True,
           "self-registration should be enabled by default")
        ok("monthlyTokenLimit" not in public.json(),
           "public policy disclosed an internal quota value")

        first_enroll = await enroll(client, device_1, key_1)
        ok(first_enroll.status_code == 200, "device enrollment failed")
        ok(first_enroll.json().get("activationRequired") is True,
           "an unbound device received a session")

        first_login = await login(
            client, device_1, key_1, account, password)
        ok(first_login.status_code == 200,
           "existing username sign-in failed: " + first_login.text)
        first_data = first_login.json()
        ok(first_data.get("created") is False,
           "password sign-in must not silently register")
        ok(first_data.get("session") and first_data.get("expiresIn"),
           "sign-in did not issue a bounded device session")
        ok(first_data.get("user", {}).get("username") == account,
           "safe user profile is missing from sign-in response")
        ok(password not in first_login.text and "password_hash" not in first_login.text
           and "pbkdf2$" not in first_login.text and '"password":' not in first_login.text,
           "sign-in response exposed password material")
        user_id = first_data["user"]["id"]
        session_headers = {
            "Authorization": "Device " + first_data["session"],
        }

        me = await client.get(
            "/api/v1/client-auth/me",
            headers=session_headers,
        )
        ok(me.status_code == 200 and
           me.json().get("user", {}).get("id") == user_id,
           "bound employee identity is not available after sign-in")

        resumed = await enroll(client, device_1, key_1)
        ok(resumed.status_code == 200 and resumed.json().get("session"),
           "trusted device did not renew its short session")
        ok(resumed.json().get("user", {}).get("id") == user_id,
           "trusted device renewed as the wrong employee")

        warm = await client.get("/api/v1/config", headers=session_headers)
        ok(warm.status_code == 200, "warm authenticated request failed")
        statements: list[str] = []

        def capture_sql(
            _conn, _cursor, statement, _parameters, _context, _many,
        ) -> None:
            statements.append(str(statement).lstrip().upper())

        event.listen(
            engine.sync_engine,
            "before_cursor_execute",
            capture_sql,
        )
        try:
            hot = await client.get(
                "/api/v1/config",
                headers=session_headers,
            )
        finally:
            event.remove(
                engine.sync_engine,
                "before_cursor_execute",
                capture_sql,
            )
        sql = [
            item for item in statements
            if item.startswith(("SELECT", "UPDATE", "INSERT", "DELETE"))
        ]
        ok(hot.status_code == 200, "hot authenticated request failed")
        ok(len(sql) == 1 and "JOIN" in sql[0],
           "quota policy added a database round trip to every request: " +
           str(len(sql)))

        second_enroll = await enroll(client, device_2, key_2)
        ok(second_enroll.status_code == 200, "second device enrollment failed")
        wrong = await login(
            client, device_2, key_2, account, "Wrong-pass-123")
        ok(wrong.status_code == 401,
           "wrong password rebound an employee account")
        async with SessionLocal() as session:
            row = await session.get(models.Client, device_2)
            ok(row is not None and row.auth_state == "pending" and
               not row.user_ref,
               "failed sign-in changed the device binding")

        second_login = await login(
            client, device_2, key_2, account, password)
        ok(second_login.status_code == 200 and
           second_login.json().get("created") is False,
           "existing employee could not bind another trusted device")

        logout = await client.post(
            "/api/v1/client-auth/logout",
            headers={"X-Device-Key": key_1},
            json={"device": device_1},
        )
        ok(logout.status_code == 200 and
           logout.json().get("activationRequired") is True,
           "explicit logout did not unbind the current device")
        stale = await client.get(
            "/api/v1/config",
            headers=session_headers,
        )
        ok(stale.status_code in (401, 403),
           "old session remained usable after explicit logout")
        logged_out_enroll = await enroll(client, device_1, key_1)
        ok(logged_out_enroll.status_code == 200 and
           not logged_out_enroll.json().get("session"),
           "logged-out device silently signed back in")
        relogin = await login(
            client, device_1, key_1, account, password)
        ok(relogin.status_code == 200 and
           relogin.json().get("created") is False,
           "employee could not explicitly sign in again")
        active_session = relogin.json()["session"]
        active_headers = {"Authorization": "Device " + active_session}

        disable = await client.put(
            "/api/v1/admin/client-auth-policy",
            headers=admin_headers,
            json={"allowSelfRegistration": False},
        )
        ok(disable.status_code == 200 and
           disable.json().get("allowSelfRegistration") is False,
           "administrator could not disable self-registration")
        await enroll(client, device_3, key_3)
        blocked = await client.post("/api/v1/client-auth/email-challenges",
            headers={"X-Device-Key": key_3},
            json={"device": device_3, "email": "new.employee@example.test", "purpose": "register"})
        ok(blocked.status_code == 403 and
           blocked.json().get("detail", {}).get("code") ==
           "SELF_REGISTRATION_DISABLED",
           "disabled self-registration still created an account")

        quota_policy = await client.put(
            "/api/v1/admin/client-auth-policy",
            headers=admin_headers,
            json={
                "allowSelfRegistration": True,
                "tokenLimitEnabled": True,
                "monthlyTokenLimit": 10,
            },
        )
        ok(quota_policy.status_code == 200 and
           quota_policy.json().get("monthlyTokenLimit") == 10,
           "administrator could not enable the monthly token limit")

        async with SessionLocal() as session:
            session.add(models.AIUsageEvent(
                idempotency_key="client-auth-quota-smoke",
                billing_user_id=user_id,
                total_tokens=10,
                source_type="chat",
            ))
            await session.commit()
        client_access.invalidate_quota(user_id)

        exceeded = await client.get(
            "/api/v1/client-auth/authorize-ai",
            headers=active_headers,
        )
        ok(exceeded.status_code == 403 and
           exceeded.json().get("detail", {}).get("code") ==
           "TOKEN_QUOTA_EXCEEDED",
           "device could start AI work after exhausting its token quota")
        readable = await client.get("/api/v1/config", headers=active_headers)
        ok(readable.status_code == 200, "quota blocked ordinary configuration reads")
        quota_login = await login(
            client, device_1, key_1, account, password)
        ok(quota_login.status_code == 200 and quota_login.json().get("quota", {}).get("exceeded") is True,
           "quota must not prevent account/security sign-in")
        quota_enroll = await enroll(client, device_1, key_1)
        ok(quota_enroll.status_code == 200 and quota_enroll.json().get("session"),
           "quota must not prevent trusted-session renewal")
        quota_me = await client.get("/api/v1/client-auth/me", headers=active_headers)
        ok(quota_me.status_code == 200 and quota_me.json().get("quota", {}).get("exceeded") is True,
           "quota must not prevent account management")

        raise_limit = await client.put(
            "/api/v1/admin/client-auth-policy",
            headers=admin_headers,
            json={"monthlyTokenLimit": 100},
        )
        ok(raise_limit.status_code == 200,
           "administrator could not raise the quota")
        restored = await enroll(client, device_1, key_1)
        ok(restored.status_code == 200 and restored.json().get("session"),
           "trusted device did not recover after quota was raised")

    async with SessionLocal() as session:
        user = await client_access.find_user(session, account)
        bound_1 = await session.get(models.Client, device_1)
        bound_2 = await session.get(models.Client, device_2)
        ok(user is not None and user.password_hash != password and
           user.password_hash.startswith("pbkdf2$"),
           "employee password was not stored as a one-way hash")
        ok(user is not None and user.org_id == "auth-root",
           "self-registered employee did not receive the default root org")
        ok(bound_1 is not None and bound_1.user_ref == user_id and
           bound_2 is not None and bound_2.user_ref == user_id,
           "employee identity was not bound to both execution devices")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(run())
    print(f"client auth smoke: {checks} checks passed")
