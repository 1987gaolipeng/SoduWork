"""Real loopback Hub API + CI signer/stager/activator; fixture installer bytes only."""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request


def main():
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="soduwork-release-pipeline-") as temporary:
        root = Path(temporary)
        os.environ.update(DATABASE_URL="sqlite+aiosqlite:///" + (root / ".smoke.db").as_posix(),
            CLIENT_UPDATE_DIR=str(root / "hub-artifacts"), AUTH_SECRET="isolated-pipeline-test-secret",
            ADMIN_PASS="isolated-pipeline-test-password")
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        key = Ed25519PrivateKey.generate()
        seed = base64.b64encode(key.private_bytes(serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode()
        public = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw,
            serialization.PublicFormat.Raw)).decode()
        trust = {"schema": 1, "keys": {"pipeline-fixture": public}}
        os.environ["CLIENT_UPDATE_PUBLIC_KEYS"] = json.dumps(trust)

        from fastapi import FastAPI
        import uvicorn
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from app.api import admin, client_updates, download
        from app.auth import hash_password
        from app.db import Base, get_session
        from app.models import Role, User, ClientRelease, AuditLog
        engine = create_async_engine(os.environ["DATABASE_URL"])
        sessions = async_sessionmaker(engine, expire_on_commit=False)

        @asynccontextmanager
        async def lifespan(_app):
            async with engine.begin() as conn:
                await conn.run_sync(lambda c: Base.metadata.create_all(c,
                    tables=[Role.__table__, User.__table__, ClientRelease.__table__, AuditLog.__table__]))
            async with sessions() as session:
                session.add(Role(id="publisher-role", name="CI publisher", permissions=["client.update"]))
                session.add(User(id="publisher-user", username="publisher", display_name="Fixture publisher",
                    password_hash=hash_password("fixture-password"), role_id="publisher-role", is_active=True, is_super=False))
                await session.commit()
            yield
            await engine.dispose()

        app = FastAPI(lifespan=lifespan)
        for router in (admin.router, client_updates.admin_router, download.router):
            app.include_router(router)

        async def session_override():
            async with sessions() as session:
                yield session
        app.dependency_overrides[get_session] = session_override
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        origin = "http://127.0.0.1:" + str(listener.getsockname()[1])
        server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
        thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
        thread.start()
        try:
            for _ in range(200):
                if server.started:
                    break
                if not thread.is_alive():
                    raise AssertionError("Isolated Hub failed to start")
                time.sleep(0.05)
            assert server.started
            checkout = root / "checkout"
            for name in ["tools/sign-client-release.mjs", "client/scripts/installer-compatibility-report.cjs",
                         "client/main/client-update-contract.js", "tools/ci/verify-client-publication.cjs",
                         "tools/ci/release-artifacts.cjs", "tools/ci/publish-client.cjs"]:
                target = checkout / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(repo / name, target)
            (checkout / "client/package.json").write_text(json.dumps({"version": "9.9.1"}))
            (checkout / "client/update-trust.json").write_text(json.dumps(trust))
            key_file = root / "test.key"
            key_file.write_text(seed)
            key_file.chmod(0o600)
            dist = checkout / "client/dist"
            dist.mkdir()
            for fmt in ("deb", "rpm", "tar.gz"):
                (dist / f"SoduWork-9.9.1-linux.{fmt}").write_bytes(b"fixture-installer-only\n" * 60000)
            environment = {**os.environ, "CI_COMMIT_SHA": "a" * 40, "CI_PIPELINE_ID": "1", "CI_JOB_ID": "2",
                "CI_COMMIT_REF_PROTECTED": "true", "CI_PIPELINE_CREATED_AT": "2026-10-15T02:00:00Z",
                "SODUWORK_RELEASE_PLATFORMS": "linux", "SODUWORK_RELEASE_HUB_URL": origin,
                "SODUWORK_RELEASE_USER": "publisher", "SODUWORK_RELEASE_PASSWORD": "fixture-password",
                "SODUWORK_CLIENT_CHANNEL": "stable", "SODUWORK_CLIENT_COMPAT_PREFIX": "SoduWork", "SODUWORK_CLIENT_RELEASE_UPLOAD_TOKEN": "",
                "SODUWORK_CLIENT_SIGNING_KEY_ID": "pipeline-fixture", "SODUWORK_CLIENT_SIGNING_KEY_FILE": str(key_file),
                "SODUWORK_CLIENT_TRUST_FILE": str(checkout / "client/update-trust.json")}

            def node(script, *args, success=True, extra=None):
                result = subprocess.run(["node", str(checkout / script), *args], cwd=checkout,
                    env={**environment, **(extra or {})}, text=True, capture_output=True, timeout=90)
                assert (result.returncode == 0) == success, result.stdout + result.stderr
                return result

            node("tools/ci/release-artifacts.cjs", "inventory", "linux")
            build = json.loads((dist / "linux-build.json").read_text())
            evidence = checkout / "release-evidence/linux"
            evidence.mkdir(parents=True)
            receipt = dict(schema=1, kind="soduwork-native-install-acceptance", ok=True,
                sourceCommit=build["sourceCommit"], pipelineId=build["pipelineId"], artifacts=build["artifacts"],
                checks=[dict(name=name, ok=True) for name in
                    ["ubuntu22-deb", "ubuntu24-deb", "rocky9-rpm", "ubuntu22-tgz"]],
                limitations=["Fixture receipt for API orchestration testing; not native installation evidence."])
            receipt_file = evidence / "acceptance.json"
            receipt_file.write_text(json.dumps(receipt))
            command = "tools/ci/publish-client.cjs"
            node(command, "stage", "linux", success=False, extra={"CI_COMMIT_REF_PROTECTED": "false"})
            receipt["ok"] = False
            receipt_file.write_text(json.dumps(receipt))
            node(command, "stage", "linux", success=False)
            receipt["ok"] = True
            receipt_file.write_text(json.dumps(receipt))
            node(command, "stage", "linux")
            signed = {file.name: file.read_bytes() for file in (evidence / "staged").glob("*.release.json")}
            # Even a leftover compatibility variable must not create aliases.
            assert len(signed) == 3 and all(name.startswith("SoduWork-") for name in signed)
            # A client must reject changing the artifact name after signing.
            from cryptography.exceptions import InvalidSignature
            for blob in signed.values():
                bundle = json.loads(blob)
                signature = base64.b64decode(bundle.pop("signature"))
                canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
                key.public_key().verify(signature, canonical(bundle))
                bundle["artifact"]["name"] = "changed-" + bundle["artifact"]["name"]
                try:
                    key.public_key().verify(signature, canonical(bundle))
                    raise AssertionError("Renaming a signed artifact must fail")
                except InvalidSignature:
                    pass
            shutil.rmtree(evidence / "staged")
            node(command, "stage", "linux")
            assert signed == {file.name: file.read_bytes() for file in (evidence / "staged").glob("*.release.json")}

            def api(route, token=None, body=None):
                request = urllib.request.Request(origin + route,
                    data=json.dumps(body).encode() if body else None,
                    headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
                with urllib.request.urlopen(request, timeout=10) as response:
                    return json.load(response)
            token = api("/api/v1/admin/login", body={"user": "publisher", "pw": "fixture-password"})["token"]
            rows = api("/api/v1/admin/client-releases", token)["releases"]
            assert len(rows) == 3 and not any(row["enabled"] for row in rows)
            assert all(row["artifactName"].startswith("SoduWork-") for row in rows)
            # Old alias receipts and added alias entries must never reach activation.
            index_file = evidence / "staged/index.json"
            index = json.loads(index_file.read_text())
            index_file.write_text(json.dumps({**index, "schema": 2, "compatibilityPrefix": "SoduWork"}))
            node(command, "enable", success=False)
            alias = {**index["entries"][0], "sourceName": index["entries"][0]["name"],
                "name": index["entries"][0]["name"].replace("SoduWork-", "SoduWork-", 1)}
            index_file.write_text(json.dumps({**index, "entries": [*index["entries"], alias]}))
            node(command, "enable", success=False)
            index_file.write_text(json.dumps(index))
            node(command, "enable", success=False, extra={"SODUWORK_RELEASE_PLATFORMS": "windows,linux"})
            assert not any(row["enabled"] for row in api("/api/v1/admin/client-releases", token)["releases"])
            # A server-side integrity failure records partial activation; retry
            # uses the same IDs after the fixture artifact has been restored.
            corrupt = root / "hub-artifacts/stable/linux/x64/9.9.1/SoduWork-9.9.1-linux.rpm"
            original = corrupt.read_bytes()
            corrupt.write_bytes(b"corrupted")
            node(command, "enable", success=False)
            failed = json.loads((checkout / "release-evidence/activation.json").read_text())
            assert not failed["ok"] and len(failed["enabled"]) == 1
            corrupt.write_bytes(original)
            node(command, "enable")
            node(command, "enable")
            node(command, "stage", "linux")
            rows = api("/api/v1/admin/client-releases", token)["releases"]
            assert len(rows) == 3 and all(row["enabled"] for row in rows)
            assert all(row["sha256"] == hashlib.sha256((dist / row["artifactName"]).read_bytes()).hexdigest() for row in rows)
            public_info = api("/api/v1/download/client/linux/info")
            for fmt in ("deb", "rpm", "tar.gz"):
                assert public_info["formats"][fmt]["filename"] == f"SoduWork-9.9.1-linux.{fmt}"
                with urllib.request.urlopen(origin + "/api/v1/download/client/linux/" + fmt) as response:
                    assert hashlib.sha256(response.read()).hexdigest() == public_info["formats"][fmt]["sha256"]
            node("tools/ci/verify-client-publication.cjs")
            verification = json.loads((checkout / "release-evidence/publication-verification.json").read_text())
            assert verification["ok"] and len(verification["artifacts"]) == 3
            print("release pipeline: protected ref, failed receipt, stage, clean retry, complete-set check, integrity rejection and activation retry passed")
        finally:
            server.should_exit = True
            thread.join(timeout=15)
            listener.close()
            assert not thread.is_alive(), "Isolated Hub must stop"


if __name__ == "__main__":
    main()
