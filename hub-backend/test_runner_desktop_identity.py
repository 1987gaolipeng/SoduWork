"""Upgrade regressions; isolated storage and database, no real device credentials."""
import asyncio
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from unittest.mock import AsyncMock
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["AUTH_SECRET"] = "runner-identity-test-only-not-a-real-secret"

from app.services import runner_handshake


class DesktopIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def identity(self, hub="https://hub.fixture.invalid", device="device-old", **kwargs):
        from app.services.runner_desktop_identity import select
        return select(self.root, hub, device, "legacy-runner", **kwargs)

    def test_healthy_upgrade_and_restart_preserve_existing_runner(self):
        self.assertEqual(self.identity(), "legacy-runner")
        self.assertEqual(self.identity(), "legacy-runner")

    def test_windows_filter_rename_failure_persists_identity_across_restart(self):
        error = FileNotFoundError(errno.ENOENT, "injected Windows filter failure")
        error.winerror = 2
        with patch("app.services.durable_file.os.replace", side_effect=error):
            first = self.identity()
        self.assertEqual(first, "legacy-runner")
        self.assertEqual(self.identity(), first)
        self.assertTrue((self.root / "desktop-runner-identities.json.wal").is_file())

    def test_recovered_device_and_changed_hub_do_not_claim_previous_identity(self):
        first = self.identity()
        recovered = self.identity(device="device-recovered")
        other_hub = self.identity(hub="https://other.fixture.invalid")
        self.assertEqual(len({first, recovered, other_hub}), 3)
        self.assertEqual(self.identity(), first)
        self.assertEqual(self.identity(device="device-recovered"), recovered)

    def test_already_broken_upgrade_recovers_once_without_erasing_legacy_files(self):
        (self.root / "runner-id").write_text("legacy-runner")
        self.assertEqual(self.identity(), "legacy-runner")
        repaired = self.identity(rejected_id="legacy-runner")
        self.assertNotEqual(repaired, "legacy-runner")
        self.assertEqual(self.identity(), repaired)
        with self.assertRaisesRegex(ValueError, "身份"):
            self.identity(rejected_id=repaired)
        self.assertEqual((self.root / "runner-id").read_text(), "legacy-runner")

    def test_failed_persistence_does_not_return_a_transient_new_id(self):
        self.identity()
        with patch("app.services.durable_file.write_bytes", side_effect=OSError("fixture denied")):
            with self.assertRaises(OSError):
                self.identity(rejected_id="legacy-runner")
        self.assertEqual(self.identity(), "legacy-runner")


class DesktopIdentityStartupTests(unittest.TestCase):
    def check_failed_startup(self, *, unreadable=False):
        # Exercise the real entrypoint before Runner construction, with only
        # disposable storage and fake credentials. No Hub connection is made.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            seed = data / "runner-id"
            seed.write_text("fixture-legacy-runner", encoding="utf-8")
            record = data / "desktop-runner-identities.json"
            if unreadable:
                record.mkdir()  # Deterministic read failure on every platform.
            else:
                record.write_bytes(b'{"fixture-private-detail":')
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("SODUWORK_", "SODUWORK_"))}
            env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8",
                       HOME=str(root / "profile"), USERPROFILE=str(root / "profile"),
                       SODUWORK_DATA_ROOT=str(data))
            for key in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PI_CODING_AGENT_DIR"):
                env.pop(key, None)
            config = {"hub": "http://127.0.0.1:1", "clientId": "fixture-device",
                      "secret": "fixture-private-secret", "dataRoot": str(data),
                      "workRoot": str(root / "work"), "capabilityGrants": []}
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("runner_main.py")), "--config-stdin"],
                input="@@SODUWORK_RUNNER_CONFIG@@" + json.dumps(config) + "\n",
                cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertNotEqual(result.returncode, 0)
            prefix = "@@SODUWORK_RUNNER_STATUS@@"
            statuses = [json.loads(line[len(prefix):]) for line in result.stdout.splitlines()
                        if line.startswith(prefix)]
            code = "IDENTITY_STORAGE_FAILED" if unreadable else "IDENTITY_RECOVERY_FAILED"
            self.assertEqual(statuses, [{"state": "error", "code": code}])
            self.assertNotIn(str(data), result.stdout)
            self.assertNotIn("fixture-private", result.stdout)
            self.assertEqual(seed.read_text(), "fixture-legacy-runner")
            if unreadable:
                self.assertEqual(list(record.iterdir()), [])
            else:
                self.assertEqual(record.read_bytes(), b'{"fixture-private-detail":')

    def test_corrupt_identity_record_reports_failure_before_runner_construction(self):
        self.check_failed_startup()

    def test_unreadable_identity_record_reports_storage_failure_before_runner_construction(self):
        self.check_failed_startup(unreadable=True)


class HandshakeRejectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_identity_repair_preserves_only_the_same_devices_durable_queue(self):
        import runner_main
        from app.services import local_base
        with tempfile.TemporaryDirectory() as root, patch.object(local_base, "_data_root", return_value=root):
            def machine(device, rid):
                return runner_main.Runner("https://hub.fixture.invalid", "", device, rid,
                                          journal_runner_id="legacy-runner")
            first = machine("device-new", "legacy-runner")
            first._admission.submit("fixture-operation", "fixture-ref", "manual", "dispatch", {})
            first._admission._journal.close()
            recovered = machine("device-new", "scoped-runner")
            other = machine("device-old", "legacy-runner")
            try:
                self.assertEqual(len(recovered._admission.active_items()), 1)
                self.assertEqual(len(other._admission.active_items()), 0)
            finally:
                recovered._admission._journal.close()
                other._admission._journal.close()

    async def test_identity_conflict_is_distinct_from_revocation_and_network_failure(self):
        class Wire:
            async def send(self, _):
                pass
            async def recv(self):
                return json.dumps({"op": "bye", "code": "RUNNER_IDENTITY_CONFLICT",
                                   "error": "执行机身份属于另一台设备"})
        wire = Wire()
        with self.assertRaises(ConnectionError) as rejected:
            await runner_handshake.negotiate(wire, wire.send, {})
        self.assertEqual(getattr(rejected.exception, "code", ""), "RUNNER_IDENTITY_CONFLICT")


class RegistrationIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovered_device_is_rejected_then_registers_independently(self):
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from app.automation_models import RunnerNode
        from app.api import runner_ws
        from app.services import runner_hub, runner_registry, cluster_runtime
        from starlette.websockets import WebSocketDisconnect

        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(RunnerNode.__table__.create)
        previous = runner_hub._Runner(None, {"runnerId": "legacy-runner", "clientId": "device-old"})
        async with sessions() as session:
            await runner_registry.record(session, previous, force=True)
            await session.commit()

        class Socket:
            client = SimpleNamespace(host="127.0.0.1")
            headers = {"x-soduwork-device": "device-recovered", "x-soduwork-secret": "fixture-only"}
            def __init__(self, rid):
                self.rid, self.sent, self.closed = rid, [], None
            async def accept(self):
                pass
            async def receive_json(self):
                return {"op": "hello", "runnerId": self.rid, "clientId": "device-recovered",
                        "tags": ["soduwork-client"], "agents": [{"key": "pi"}], "inventoryReady": True}
            async def send_json(self, message):
                self.sent.append(message)
            async def close(self, code=1000, **_):
                self.closed = code
            async def receive(self):
                raise WebSocketDisconnect()

        try:
            with tempfile.TemporaryDirectory() as root, \
                    patch.object(runner_ws, "SessionLocal", sessions), \
                    patch.object(runner_ws, "_auth", AsyncMock(return_value=(True, ""))), \
                    patch.object(runner_ws.device_auth, "client_from_secret",
                                 AsyncMock(return_value=SimpleNamespace(user_ref=""))), \
                    patch.object(runner_ws, "_reconcile_runner_restart", AsyncMock()), \
                    patch.object(cluster_runtime, "register", AsyncMock()), \
                    patch.object(cluster_runtime, "check_owner", AsyncMock()):
                from app.services.runner_desktop_identity import select
                args = (root, "https://hub.fixture.invalid", "device-recovered", "legacy-runner")
                wire = Socket(select(*args))
                await runner_ws.runner_ws(wire)
                self.assertEqual(wire.closed, 4409)
                self.assertEqual(wire.sent[0].get("code"), "RUNNER_IDENTITY_CONFLICT")
                repaired = select(*args, rejected_id="legacy-runner")
                wire = Socket(repaired)
                await runner_ws.runner_ws(wire)
                self.assertEqual(wire.sent[0]["op"], "welcome")
                async with sessions() as session:
                    self.assertEqual((await session.get(RunnerNode, "legacy-runner")).client_id, "device-old")
                    self.assertEqual((await session.get(RunnerNode, repaired)).client_id, "device-recovered")
        finally:
            await engine.dispose()


if __name__ == "__main__":
    unittest.main()
