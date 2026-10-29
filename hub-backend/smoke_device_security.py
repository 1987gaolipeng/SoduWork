"""Offline security contract for SoduWork device identity and resource tickets."""
from __future__ import annotations

import asyncio
from contextlib import closing
import hashlib
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


STRICT = "--staged" not in sys.argv
_tmp = tempfile.TemporaryDirectory(prefix="soduwork-device-security-")
_root = Path(_tmp.name)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (_root / ".smoke-device.db").as_posix()
os.environ["AUTH_SECRET"] = "device-security-smoke-secret-with-enough-entropy"
os.environ["DEVICE_AUTH_COMPAT"] = "false" if STRICT else "true"

import httpx  # noqa: E402
from sqlalchemy import event  # noqa: E402

from app import automation_models, models  # noqa: E402,F401
from app.auth import sign_token  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.realtime import Hub, hub as realtime_hub  # noqa: E402
from app.services import (device_auth, device_connections, resource_access,
                          runner_hub, storage, task_execution_contract)  # noqa: E402


checks = 0


def ok(value, message: str) -> None:
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


class _FakeSocket:
    def __init__(self):
        self.accepted = False
        self.closed: list[int] = []

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000) -> None:
        self.closed.append(code)

    async def send_json(self, _message: dict) -> None:
        return None


async def api_contract() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    gate = asyncio.Event()

    class _HandshakeSocket(_FakeSocket):
        async def accept(self) -> None:
            await gate.wait()
            self.accepted = True

    limited_hub = Hub()
    handshakes = [asyncio.create_task(
        limited_hub.connect("connection-limit-device", _HandshakeSocket())
    ) for _ in range(4)]
    await asyncio.sleep(0)
    gate.set()
    admitted = await asyncio.gather(*handshakes)
    ok(sum(bool(item) for item in admitted) == 3,
       "concurrent WebSocket handshakes bypassed the per-device connection limit")

    async with SessionLocal() as session:
        admin = models.User(
            id="security-admin", username="security-admin", display_name="Security Admin",
            is_super=True, is_active=True, auth_version=1,
        )
        session.add(admin)
        session.add(models.Client(
            id="assigned-without-proof", user_ref=admin.id,
            secret_hash="", auth_state="pending",
        ))
        inactive = models.User(
            id="security-inactive", username="security-inactive",
            display_name="Inactive owner", is_active=False, auth_version=1,
        )
        session.add(inactive)
        session.add(models.Client(
            id="inactive-owner-device", user_ref=inactive.id,
            secret_hash=device_auth.hash_secret("i" * 48), auth_state="active",
            auth_version=1,
        ))
        await session.commit()

    admin_token = sign_token("security-admin", 1)
    admin_headers = {"Authorization": "Bearer " + admin_token}
    device_id = "device-security-1"
    device_key = "k" * 48
    enroll_headers = {"X-Device-Key": device_key}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://soduwork.test") as client:
        cors = await client.options(
            "/api/v1/config",
            headers={"Origin": "null", "Access-Control-Request-Method": "GET",
                     "Access-Control-Request-Headers": "authorization"},
        )
        ok(cors.status_code == 200 and cors.headers.get("access-control-allow-origin") == "*",
           "file-origin Electron renderer cannot reach the Hub with webSecurity enabled")
        first = await client.post(
            "/api/v1/clients/enroll", headers=enroll_headers,
            json={"device": device_id, "name": "Security workstation", "platform": "test"},
        )
        ok(first.status_code == 200, "new device enrollment failed: " + first.text)
        body = first.json()
        ok(body.get("activationRequired") is True and not body.get("session"),
           "a new device bypassed administrator activation")
        ok("secret" not in body and "secretHash" not in body,
           "enrollment response disclosed a long-lived credential")

        unproven = await client.post(
            "/api/v1/clients/enroll", headers={"X-Device-Key": "u" * 48},
            json={"device": "assigned-without-proof", "name": "Old assigned row"},
        )
        ok(unproven.status_code == 200 and unproven.json().get("activationRequired") is True
           and not unproven.json().get("session"),
           "an assigned row without an existing credential bypassed activation")
        inactive_owner = await client.post(
            "/api/v1/clients/enroll", headers={"X-Device-Key": "i" * 48},
            json={"device": "inactive-owner-device", "name": "Inactive owner device"},
        )
        ok(inactive_owner.status_code == 403 and not inactive_owner.json().get("session"),
           "an active device bound to a disabled owner received a session")

        async with SessionLocal() as session:
            try:
                await device_auth.client_from_transport(
                    session, device_id, secret=device_key, allow_legacy=True)
                pending_transport_blocked = False
            except device_auth.DeviceAuthError:
                pending_transport_blocked = True
        ok(pending_transport_blocked,
           "a pending device key opened an upgraded transport channel")

        legacy = await client.get(
            "/api/v1/config",
            headers={"X-Soduwork-Device": device_id, "X-Soduwork-Secret": device_key},
        )
        ok(legacy.status_code == 401 if STRICT else legacy.status_code in (401, 403),
           "a pending device gained business access through compatibility headers")
        old_register = await client.post(
            "/api/v1/clients/register",
            headers={"X-Soduwork-Secret": device_key}, json={"device": device_id},
        )
        ok(old_register.status_code == 404 if STRICT else old_register.status_code == 200,
           "legacy registration behavior does not match the migration stage")

        assigned = await client.post(
            f"/api/v1/admin/clients/{device_id}/assign",
            headers=admin_headers, json={"userId": "security-admin"},
        )
        ok(assigned.status_code == 200 and assigned.json().get("authState") == "active",
           "owner assignment did not atomically activate the enrolled device: " + assigned.text)

        second = await client.post(
            "/api/v1/clients/enroll", headers=enroll_headers,
            json={"device": device_id, "name": "Security workstation", "platform": "test"},
        )
        ok(second.status_code == 200 and second.json().get("session"),
           "activated device did not receive a short-lived session: " + second.text)
        device_session = second.json()["session"]
        session_headers = {"Authorization": "Device " + device_session}
        config = await client.get("/api/v1/config", headers=session_headers)
        ok(config.status_code == 200, "device session did not authorize a business API")

        statements: list[str] = []

        def capture_sql(_conn, _cursor, statement, _parameters, _context, _many) -> None:
            statements.append(str(statement).lstrip().upper())

        event.listen(engine.sync_engine, "before_cursor_execute", capture_sql)
        try:
            warm_config = await client.get("/api/v1/config", headers=session_headers)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", capture_sql)
        auth_sql = [statement for statement in statements
                    if statement.startswith(("SELECT", "UPDATE", "INSERT", "DELETE"))]
        ok(warm_config.status_code == 200,
           "a warm authenticated request failed")
        ok(len(auth_sql) == 1 and "JOIN" in auth_sql[0],
           "a warm device request used more than one database round trip: " +
           str(len(auth_sql)))
        heartbeat_id = "device-heartbeat-probe"
        ok(device_auth.should_write_last_seen(heartbeat_id, now=1_000.0) and
           not device_auth.should_write_last_seen(heartbeat_id, now=1_029.0) and
           device_auth.should_write_last_seen(heartbeat_id, now=1_031.0),
           "device presence writes were not bounded to one heartbeat interval")
        if not STRICT:
            compat = await client.get(
                "/api/v1/config",
                headers={"X-Soduwork-Device": device_id, "X-Soduwork-Secret": device_key},
            )
            ok(compat.status_code == 200,
               "an activated pre-v1 client could not use the bounded compatibility path")

        async with SessionLocal() as session:
            transport_client = await device_auth.client_from_transport(
                session, device_id, secret=device_key, allow_legacy=True)
        ok(transport_client.id == device_id,
           "an active compatibility device could not open an upgraded channel")

        async with SessionLocal() as session:
            row = await session.get(models.Client, device_id)
            ok(row is not None and row.secret_hash == hashlib.sha256(device_key.encode()).hexdigest(),
               "Hub did not persist the device key as a one-way digest")
            ok(getattr(row, "secret", None) in (None, ""),
               "Hub persisted a plaintext device key")
            proxy_ticket, _ = device_auth.issue_proxy_ticket(row)
            mcp_ticket, _ = device_auth.issue_mcp_ticket(row)

            task = models.Task(
                id="task-security-1", title="Attachment security",
                owner_client_id=device_id, status="todo",
            )
            attachment = models.Attachment(
                id="attachment-security-1", task_id="task-security-1",
                filename="proof.txt", content_type="text/plain", size=5,
                storage_key="security/proof.txt", backend="local",
            )
            active_content = models.Attachment(
                id="attachment-security-2", task_id="task-security-1",
                filename="active.svg", content_type="image/svg+xml", size=5,
                storage_key="security/active.svg", backend="local",
            )
            raster = models.Attachment(
                id="attachment-security-3", task_id="task-security-1",
                filename="safe.png", content_type="image/png", size=5,
                storage_key="security/safe.png", backend="local",
            )
            session.add_all([task, attachment, active_content, raster])
            await session.commit()

        listed = await client.get(
            "/api/v1/tasks/task-security-1/attachments", headers=session_headers,
        )
        by_id = {item.get("id"): item for item in listed.json()} if listed.status_code == 200 else {}
        ok(listed.status_code == 200 and not by_id.get("attachment-security-2", {}).get("isImage")
           and by_id.get("attachment-security-3", {}).get("isImage"),
           "attachment metadata exposed active SVG content as an inline image")
        svg_evidence = task_execution_contract.attachment_evidence(
            by_id.get("attachment-security-2", {}))
        ok(svg_evidence.get("kind") != "image",
           "the shared task trace reclassified active SVG content as previewable evidence")

        models_ok = await client.get(
            "/api/v1/ai-proxy/v1/models",
            headers={"Authorization": "Bearer " + proxy_ticket},
        )
        ok(models_ok.status_code == 200, "purpose-bound AI proxy ticket was rejected")
        proxy_wrong = await client.get(
            "/api/v1/ai-proxy/v1/models",
            headers={"Authorization": "Bearer " + mcp_ticket},
        )
        ok(proxy_wrong.status_code == 401, "MCP ticket was accepted by the AI proxy")
        proxy_device = await client.get(
            "/api/v1/ai-proxy/v1/models",
            headers={"Authorization": "Bearer " + device_session},
        )
        ok(proxy_device.status_code == 401, "general device session was accepted by the AI proxy")

        init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
        mcp_ok = await client.post(
            "/api/v1/mcp/", headers={"Authorization": "Bearer " + mcp_ticket}, json=init,
        )
        ok(mcp_ok.status_code == 200 and mcp_ok.json().get("result", {}).get("serverInfo"),
           "purpose-bound MCP ticket was rejected")
        mcp_wrong = await client.post(
            "/api/v1/mcp/", headers={"Authorization": "Bearer " + proxy_ticket}, json=init,
        )
        ok(mcp_wrong.status_code == 401, "AI proxy ticket was accepted by MCP")

        original_open_stream = storage.open_stream
        storage.open_stream = lambda _key, _backend: BytesIO(b"proof")  # type: ignore[assignment]
        try:
            stable = await client.get("/api/v1/attachments/attachment-security-1")
            ok(stable.status_code == 401,
               "attachment is downloadable without a capability ticket")
            signed_url = resource_access.attachment_url("attachment-security-1")
            ok(signed_url == resource_access.attachment_url("attachment-security-1"),
               "attachment capability URL changes on every poll and would force a repaint")
            signed = await client.get(signed_url)
            ok(signed.status_code == 200 and signed.content == b"proof",
               "valid attachment capability did not download the resource")
            ok(signed.headers.get("cache-control") == "private, no-store" and
               signed.headers.get("x-content-type-options") == "nosniff" and
               signed.headers.get("content-security-policy") == "sandbox; default-src 'none'" and
               signed.headers.get("referrer-policy") == "no-referrer" and
               signed.headers.get("cross-origin-resource-policy") == "cross-origin",
               "sensitive attachment response lacks hardening headers")
            svg = await client.get(resource_access.attachment_url("attachment-security-2"))
            png = await client.get(resource_access.attachment_url("attachment-security-3"))
            ok(svg.headers.get("content-disposition", "").startswith("attachment;"),
               "active SVG content was allowed to render inline on the Hub origin")
            ok(png.headers.get("content-disposition", "").startswith("inline;"),
               "safe raster image was not available for inline evidence preview")
            token = urlsplit(signed_url).query.removeprefix("ticket=")
            wrong_resource = await client.get(
                "/api/v1/attachments/attachment-security-3?ticket=" + token)
            ok(wrong_resource.status_code == 401, "attachment ticket was reusable for another resource")
        finally:
            storage.open_stream = original_open_stream  # type: ignore[assignment]

        event_socket = _FakeSocket()
        runner_socket = _FakeSocket()
        terminal_socket = _FakeSocket()
        ok(await realtime_hub.connect(device_id, event_socket),
           "could not create the revocation event-channel fixture")
        runner = runner_hub.add(runner_socket, {
            "runnerId": "security-runner", "clientId": device_id,
            "host": "security-host", "agents": [],
        })
        runner.dispatch_mode = "accepting"
        await device_connections.register_terminal(device_id, terminal_socket)

        revoked = await client.post(
            f"/api/v1/admin/clients/{device_id}/revoke", headers=admin_headers,
        )
        ok(revoked.status_code == 200, "administrator could not revoke a device")
        ok(event_socket.closed == [4403] and terminal_socket.closed == [4403]
           and runner_socket.closed == [4403] and runner_hub.get("security-runner") is None,
           "device revocation did not tear down every live channel")
        after_revoke = await client.get("/api/v1/config", headers=session_headers)
        ok(after_revoke.status_code in (401, 403), "revoked device session remained usable")
        async with SessionLocal() as session:
            try:
                await device_auth.client_from_transport(
                    session, device_id, secret=device_key, allow_legacy=True)
                revoked_transport_blocked = False
            except device_auth.DeviceAuthError:
                revoked_transport_blocked = True
        ok(revoked_transport_blocked,
           "a revoked device key reopened an upgraded transport channel")

        me = await client.get("/api/v1/admin/me", headers=admin_headers)
        ok(me.status_code == 200, "valid user session was rejected")
        async with SessionLocal() as session:
            user = await session.get(models.User, "security-admin")
            user.auth_version += 1
            await session.commit()
        stale = await client.get("/api/v1/admin/me", headers=admin_headers)
        ok(stale.status_code == 401, "stale administrator session survived auth-version change")

        async with SessionLocal() as session:
            member = models.User(
                id="security-member", username="security-member", display_name="Security Member",
                password_hash="unused", is_super=False, is_active=True, auth_version=1,
            )
            member_device = models.Client(
                id="security-member-device", user_ref=member.id,
                secret_hash=device_auth.hash_secret("m" * 48), auth_state="active",
                auth_version=1,
            )
            session.add_all([member, member_device])
            await session.commit()
            member_session, _ = device_auth.issue_session(member_device)

        disabled = await client.patch(
            "/api/v1/admin/users/security-member",
            headers={"Authorization": "Bearer " + sign_token("security-admin", 2)},
            json={"isActive": False},
        )
        ok(disabled.status_code == 200, "administrator could not deactivate a user")
        disabled_device = await client.get(
            "/api/v1/config", headers={"Authorization": "Device " + member_session},
        )
        ok(disabled_device.status_code in (401, 403),
           "deactivating a user left the user's device session usable")
        async with SessionLocal() as session:
            member_device = await session.get(models.Client, "security-member-device")
            ok(member_device.auth_state == "revoked" and member_device.auth_version > 1,
               "deactivating a user did not revoke bound device authorization")


def migration_contract() -> None:
    db = _root / "legacy-device.db"
    env = os.environ.copy()
    env["DATABASE_URL"] = "sqlite+aiosqlite:///" + db.as_posix()
    root = Path(__file__).resolve().parent
    for revision in ("0004_identity_foundation", "head"):
        result = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", revision], cwd=root, env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=120,
        )
        if revision == "0004_identity_foundation":
            ok(result.returncode == 0, "could not build the pre-security migration fixture: " + result.stdout)
            with closing(sqlite3.connect(db)) as connection:
                connection.execute(
                    "INSERT INTO client "
                    "(id, secret, user_ref, config, skills, model_keys, models, agent_models, git_creds, work_root) "
                    "VALUES (?, ?, ?, '{}', '[]', '{}', '[]', '{}', '{}', '')",
                    ("legacy-security-1", "legacy-random-device-key", "security-admin"),
                )
                connection.commit()
        else:
            ok(result.returncode == 0, "device security migration failed: " + result.stdout)
    with closing(sqlite3.connect(db)) as connection:
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(client)")}
        row = connection.execute(
            "SELECT secret_hash, auth_state, secret FROM client WHERE id='legacy-security-1'"
        ).fetchone()
    ok({"secret_hash", "auth_state", "secret"}.issubset(columns),
       "migration did not create the bounded compatibility schema")
    ok(row == (hashlib.sha256(b"legacy-random-device-key").hexdigest(), "active", None),
       "migration did not preserve a legacy device as a hashed active enrollment")


async def main() -> None:
    await api_contract()
    await engine.dispose()
    if STRICT:
        migration_contract()


try:
    asyncio.run(main())
finally:
    try:
        asyncio.run(engine.dispose())
    except Exception:
        pass
    _tmp.cleanup()

print(f"device security: {checks} checks passed")
