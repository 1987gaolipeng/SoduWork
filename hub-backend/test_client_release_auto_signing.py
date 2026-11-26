"""Installer-only HTTP publication with real archives, signatures and SQLite."""

from __future__ import annotations

import asyncio
import base64
import inspect
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import struct
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", secrets.token_urlsafe(32))
os.environ.setdefault("ADMIN_PASS", secrets.token_urlsafe(24))

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import client_updates as api
from app.db import Base, get_session
from app.models import AuditLog, ClientRelease
from app.services import client_installer_metadata as metadata
from app.services import client_release_signing as signing
from app.services import client_updates as contract


TOOL = os.environ.get("TEST_7ZIP") or shutil.which("7zz") or shutil.which("7z")


def asar(version="9.8.7", *, product="SoduWork"):
    package = json.dumps(
        {"name": "soduwork", "productName": product, "version": version}
    ).encode()
    other = json.dumps({"version": version}).encode()
    header = json.dumps(
        {
            "files": {
                "package.json": {"offset": "0", "size": len(package)},
                "version.json": {"offset": str(len(package)), "size": len(other)},
            }
        }
    ).encode()
    padding = b"\0" * (-len(header) % 4)
    size = 8 + len(header) + len(padding)
    return (
        struct.pack("<IIII", 4, size, size - 4, len(header))
        + header
        + padding
        + package
        + other
    )


def package_bytes(version="9.8.7", *, arch="arm64", product="SoduWork", extra=b""):
    stream = io.BytesIO()
    cpu = 0x0100000C if arch == "arm64" else 0x01000007
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr(
            "SoduWork.app/Contents/Resources/app.asar", asar(version, product=product)
        )
        archive.writestr(
            "SoduWork.app/Contents/MacOS/SoduWork",
            struct.pack("<II", 0xFEEDFACF, cpu) + b"\0" * 100,
        )
        archive.writestr(
            "SoduWork.app/Contents/Resources/padding", b"fixture" * 160000 + extra
        )
    return stream.getvalue()


class MetadataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_asar_and_native_headers_reject_malformed_and_foreign_identity(self):
        path = self.root / "app.asar"
        path.write_bytes(asar())
        self.assertEqual(metadata._asar_identity(path)["version"], "9.8.7")
        for data in (
            b"bad",
            asar(product="Other app"),
            struct.pack("<IIII", 4, 2, 3, 2**31),
        ):
            path.write_bytes(data)
            with self.assertRaises(contract.UpdateContractError):
                metadata._asar_identity(path)
        native = self.root / "native"
        pe = bytearray(256)
        pe[:2] = b"MZ"
        struct.pack_into("<I", pe, 60, 128)
        pe[128:134] = b"PE\0\0" + struct.pack("<H", 0x8664)
        elf = bytearray(64)
        elf[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", elf, 18, 183)
        for data, expected in [
            (pe, ("win32", "x64")),
            (elf, ("linux", "arm64")),
            (struct.pack("<II", 0xFEEDFACF, 0x01000007), ("darwin", "x64")),
        ]:
            native.write_bytes(data)
            self.assertEqual(metadata._executable_identity(native), expected)
        native.write_bytes(b"unsupported")
        with self.assertRaises(contract.UpdateContractError):
            metadata._executable_identity(native)

    def test_archive_process_bounds_and_diagnostics(self):
        output = self.root / "output"
        with self.assertRaisesRegex(contract.UpdateContractError, "超时"):
            metadata._run(
                sys.executable,
                ["-c", "import time;time.sleep(10)"],
                output,
                1024,
                time.monotonic() + 0.1,
            )
        with self.assertRaisesRegex(contract.UpdateContractError, "上限"):
            metadata._run(
                sys.executable,
                ["-c", "print('x'*4096)"],
                output,
                128,
                time.monotonic() + 5,
            )
        with self.assertRaises(contract.UpdateContractError) as error:
            metadata._run(
                sys.executable,
                [
                    "-c",
                    "import sys;sys.stderr.write('original fixture diagnostic');sys.exit(7)",
                ],
                output,
                1024,
                time.monotonic() + 5,
            )
        self.assertIn("original fixture diagnostic", str(error.exception.__cause__))
        with self.assertRaises(metadata.InstallerInspectionUnavailable) as error:
            metadata._run(
                str(self.root / "missing-tool"), [], output, 1024, time.monotonic() + 5
            )
        self.assertIsInstance(error.exception.__cause__, FileNotFoundError)

    def test_android_metadata_comes_from_manifest_not_filename(self):
        path = self.root / "SoduWork-Mobile-9.8.7.apk"
        path.write_bytes(b"fixture")

        def run(tool, args, out, *_):
            out.write_text(
                "package: name='com.example.soduwork' versionCode='9' versionName='9.8.7'\napplication-label:'SoduWork'\n"
            )

        with (
            patch.object(metadata.shutil, "which", return_value="fixture-aapt"),
            patch.object(metadata, "_run", side_effect=run),
        ):
            self.assertEqual(
                metadata.inspect_installer(path),
                {"version": "9.8.7", "platform": "android", "arch": "universal"},
            )
            renamed = path.with_name("SoduWork-Mobile-9.8.8.apk")
            path.rename(renamed)
            with self.assertRaisesRegex(contract.UpdateContractError, "不一致"):
                metadata.inspect_installer(renamed)

    @unittest.skipUnless(TOOL, "7-Zip required for real archive inspection")
    def test_real_archive_checks_internal_version_architecture_and_cleanup(self):
        path = self.root / "SoduWork-9.8.7-mac-arm64.zip"
        path.write_bytes(package_bytes())
        self.assertEqual(
            metadata.inspect_installer(path, TOOL),
            {"version": "9.8.7", "platform": "darwin", "arch": "arm64"},
        )
        for name in ["SoduWork-9.8.8-mac-arm64.zip", "SoduWork-9.8.7-mac-x64.zip"]:
            renamed = self.root / name
            renamed.write_bytes(path.read_bytes())
            with self.assertRaisesRegex(contract.UpdateContractError, "不一致"):
                metadata.inspect_installer(renamed, TOOL)
        self.assertFalse(list(self.root.glob("inspect-*")))


@unittest.skipUnless(TOOL, "7-Zip required for installer-only HTTP publication")
class AutoSigningTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.engine = create_async_engine(
            "sqlite+aiosqlite:///" + str(self.root / "test.db")
        )
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(
                lambda c: Base.metadata.create_all(
                    c, tables=[ClientRelease.__table__, AuditLog.__table__]
                )
            )
        key = Ed25519PrivateKey.generate()
        self.key_file = self.root / "key"
        self.key_id = "test-upload-key"
        self.key_file.write_bytes(
            base64.b64encode(
                key.private_bytes(
                    serialization.Encoding.Raw,
                    serialization.PrivateFormat.Raw,
                    serialization.NoEncryption(),
                )
            )
        )
        self.key_file.chmod(0o600)
        self.public = base64.b64encode(
            key.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        ).decode()
        self.settings = SimpleNamespace(
            client_update_signing_key_file=str(self.key_file),
            client_update_signing_key_id=self.key_id,
            client_update_archive_tool=TOOL,
        )
        for item in [
            patch.object(signing, "get_settings", return_value=self.settings),
            patch.object(
                contract, "trusted_public_keys", return_value={self.key_id: self.public}
            ),
            patch.object(contract, "release_root", return_value=self.root / "releases"),
            patch.dict(os.environ, {"SODUWORK_PUBLIC_DOWNLOAD_CHANNEL": "beta"}),
        ]:
            item.start()
            self.addCleanup(item.stop)
        self.app = FastAPI()
        self.app.include_router(api.admin_router)

        async def session():
            async with self.sessions() as value:
                yield value

        self.app.dependency_overrides[get_session] = session
        self.permission = (
            inspect.signature(api.upload_manual_client_release)
            .parameters["user"]
            .default.dependency
        )
        self.app.dependency_overrides[self.permission] = lambda: SimpleNamespace(
            id="fixture-user"
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://fixture"
        )
        self.addAsyncCleanup(self.client.aclose)

    async def upload(self, version="9.8.7", *, data=None, name=None, channel=None):
        return await self.client.post(
            "/api/v1/admin/client-releases/upload",
            files={
                "installer": (
                    name or f"SoduWork-{version}-mac-arm64.zip",
                    data if data is not None else package_bytes(version),
                    "application/octet-stream",
                )
            },
            data={"channel": channel} if channel is not None else {},
        )

    async def assert_empty(self):
        async with self.sessions() as session:
            self.assertEqual(
                await session.scalar(select(func.count(ClientRelease.id))), 0
            )
        incoming = self.root / "releases/.incoming"
        self.assertFalse(incoming.exists() and list(incoming.iterdir()))

    async def test_upload_signs_registers_each_package_and_preserves_enabled_retry(
        self,
    ):
        installer = package_bytes()
        response = await self.upload(data=installer)
        self.assertEqual(response.status_code, 200, response.text)
        row = response.json()["release"]
        self.assertEqual(row["channel"], "beta")
        self.assertFalse(row["enabled"])
        async with self.sessions() as session:
            stored = await session.get(ClientRelease, row["id"])
            contract.assert_trusted_release(stored)
            self.assertEqual(
                stored.sha256,
                contract.sha256_file(contract.safe_artifact_path(stored.artifact_path)),
            )
            self.assertFalse(contract.automatic_update_candidate(stored))
            stored.enabled = True
            await session.commit()
        repeated = await self.upload(data=installer)
        self.assertFalse(repeated.json()["created"])
        self.assertTrue(repeated.json()["release"]["enabled"])
        self.assertEqual(repeated.json()["release"]["id"], row["id"])
        next_package = await self.upload("9.8.8-beta.1", channel="beta")
        self.assertEqual(next_package.status_code, 200, next_package.text)
        separate = await self.upload(data=installer, channel="stable")
        self.assertEqual(separate.status_code, 200, separate.text)
        self.assertNotEqual(separate.json()["release"]["id"], row["id"])
        conflict = await self.upload(data=package_bytes(extra=b"different bytes"))
        self.assertEqual(conflict.status_code, 409)

    async def test_concurrent_identical_uploads_create_one_record(self):
        original = signing._prepare
        import threading

        barrier = threading.Barrier(2)

        def prepare(*args):
            value = original(*args)
            barrier.wait(timeout=10)
            return value

        installer = package_bytes()
        with patch.object(signing, "_prepare", side_effect=prepare):
            responses = await asyncio.gather(
                self.upload(data=installer), self.upload(data=installer)
            )
        self.assertEqual(
            [r.status_code for r in responses], [200, 200], [r.text for r in responses]
        )
        self.assertEqual(sorted(r.json()["created"] for r in responses), [False, True])
        self.assertEqual(
            responses[0].json()["release"]["id"], responses[1].json()["release"]["id"]
        )

    async def test_bad_package_channel_and_missing_signer_leave_no_record_or_input(
        self,
    ):
        for kwargs, status in [
            ({"name": "SoduWork-9.9.0-mac-arm64.zip"}, 409),
            ({"data": b"not a zip"}, 409),
            ({"channel": "unknown"}, 400),
        ]:
            response = await self.upload(**kwargs)
            self.assertEqual(response.status_code, status, response.text)
            await self.assert_empty()
        self.settings.client_update_signing_key_file = ""
        response = await self.upload()
        self.assertEqual(response.status_code, 503)
        await self.assert_empty()

    async def test_invalid_untrusted_and_overbroad_keys_fail_closed_without_disclosure(
        self,
    ):
        original = self.key_file.read_bytes()
        for raw in [b"invalid fixture key", base64.b64encode(b"x" * 32)]:
            self.key_file.write_bytes(raw)
            with self.assertLogs(api.logger, level="ERROR") as logs:
                response = await self.upload()
            self.assertEqual(response.status_code, 503)
            self.assertNotIn(raw.decode(), response.text)
            self.assertTrue(any("Traceback" in line for line in logs.output))
            await self.assert_empty()
        self.key_file.write_bytes(original)
        if os.name != "nt":
            self.key_file.chmod(0o644)
            response = await self.upload()
            self.assertEqual(response.status_code, 503)
            await self.assert_empty()

    async def test_permission_is_checked_before_signing(self):
        def denied():
            raise HTTPException(status_code=403, detail="fixture permission denied")

        self.app.dependency_overrides[self.permission] = denied
        with patch.object(
            signing, "_prepare", side_effect=AssertionError("must not sign")
        ):
            response = await self.upload()
        self.assertEqual(response.status_code, 403)
        await self.assert_empty()


if __name__ == "__main__":
    unittest.main()
