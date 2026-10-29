"""Deployment-built client release: authorize, stage, activate, and roll back."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


ROOT = Path(__file__).resolve().parent
TEMP = ROOT / f".smoke-deployment-client-release-{os.getpid()}"
DB_FILE = TEMP / "release.db"
ARTIFACT_ROOT = TEMP / "artifacts"
KEY_ID = "smoke-deployment-key"

_KEY = Ed25519PrivateKey.generate()
PRIVATE_KEY = base64.b64encode(_KEY.private_bytes(
    serialization.Encoding.Raw,
    serialization.PrivateFormat.Raw,
    serialization.NoEncryption(),
)).decode("ascii")
PUBLIC_KEY = base64.b64encode(_KEY.public_key().public_bytes(
    serialization.Encoding.Raw,
    serialization.PublicFormat.Raw,
)).decode("ascii")

shutil.rmtree(TEMP, ignore_errors=True)
TEMP.mkdir(parents=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB_FILE.as_posix()
os.environ["DB_MIGRATION_MODE"] = "auto"
os.environ["CLIENT_UPDATE_DIR"] = ARTIFACT_ROOT.as_posix()
os.environ["CLIENT_UPDATE_PUBLIC_KEYS"] = json.dumps({"keys": {KEY_ID: PUBLIC_KEY}})

from fastapi.testclient import TestClient

from app import auth
from app import automation_models as am
from app.db import SessionLocal, engine, init_db
from app.main import app
from app.models import ClientRelease, Repo, Task
from app.services import client_updates
from app.services import deployments


TASK_ID = "42000000-0000-4000-8000-000000000001"
TARGET_ID_2 = "42000000-0000-4000-8000-000000000014"
REPO_ID = "42000000-0000-4000-8000-000000000002"
ENV_ID = "42000000-0000-4000-8000-000000000003"
TARGET_ID = "42000000-0000-4000-8000-000000000004"
ARTIFACT_ID = "42000000-0000-4000-8000-000000000005"
RUN_ID = "42000000-0000-4000-8000-000000000006"
COMMIT = "a" * 40


def installer_and_bundle(version: str, release_id: str) -> tuple[Path, dict]:
    name = f"SoduWork-{version}-Setup.exe"
    installer = TEMP / name
    installer.write_bytes((f"SODUWORK-{version}\n".encode("ascii") * 140000)[:1250000])
    release = SimpleNamespace(
        id=release_id,
        version=version,
        channel="beta",
        platform="win32",
        arch="x64",
        artifact_name=name,
        artifact_size=installer.stat().st_size,
        sha256=client_updates.sha256_file(installer),
        signature="",
        key_id=KEY_ID,
        notes="deployment upload smoke",
        mandatory=False,
        min_version="",
        created_at=datetime.now(timezone.utc),
    )
    payload = client_updates.manifest_payload(release)
    return installer, {**payload, "signature": client_updates.sign(payload, PRIVATE_KEY)}


def token(run_id: str = RUN_ID, *, artifact_id: str = ARTIFACT_ID) -> str:
    return auth.sign_claims({
        "runId": run_id,
        "targetId": TARGET_ID,
        "artifactVersionId": artifact_id,
        "commit": COMMIT,
    }, ttl_seconds=600, token_type="deployment-client-upload")


def upload(client: TestClient, run_id: str, bearer: str, installer: Path,
           bundle: dict):
    with installer.open("rb") as stream:
        return client.post(
            f"/api/v1/deployment-client-releases/{run_id}",
            headers={"Authorization": "Bearer " + bearer} if bearer else {},
            files={
                "bundle": ("release.json", json.dumps(bundle).encode("utf-8"),
                           "application/json"),
                "installer": (installer.name, stream, "application/octet-stream"),
            },
        )


async def seed() -> None:
    await init_db()
    async with SessionLocal() as session:
        session.add_all([
            Repo(id=REPO_ID, project_id="soduwork-smoke", name="SoduWork",
                 git_url="https://example.invalid/soduwork.git", default_branch="release1.12"),
            Task(id=TASK_ID, title="SoduWork client release smoke", repo_id=REPO_ID),
            am.Environment(
                id=ENV_ID, key="client-beta", name="Client beta", tier="test",
                promotion_policy={"requiresAcceptance": True, "marksDelivery": True},
            ),
            am.DeploymentTarget(
                id=TARGET_ID, repo_id=REPO_ID, environment_id=ENV_ID,
                name="Signed Windows installer", provider="runner-command",
                config={"clientReleaseUpload": {"enabled": True}}, enabled=True,
            ),
            am.DeploymentTarget(
                id=TARGET_ID_2, repo_id=REPO_ID, environment_id=ENV_ID,
                name="Server deployment", provider="runner-command",
                config={}, enabled=True,
            ),
            am.ArtifactVersion(
                id=ARTIFACT_ID, task_id=TASK_ID, seq=1, kind="code",
                source_ref="release1.12", commit_sha=COMMIT,
                checksum="b" * 64, state="approved",
            ),
            am.DeploymentRun(
                id=RUN_ID, task_id=TASK_ID, artifact_version_id=ARTIFACT_ID,
                environment_id=ENV_ID, target_id=TARGET_ID, state="running",
                attempt=1, idempotency_key="smoke-client-release-1", commit_sha=COMMIT,
            ),
        ])
        await session.commit()


async def verify_staged(release_id: str) -> None:
    async with SessionLocal() as session:
        release = await session.get(ClientRelease, release_id)
        run = await session.get(am.DeploymentRun, RUN_ID)
        assert release is not None and release.enabled is False
        assert dict(run.result or {})["clientRelease"]["state"] == "staged"
        path = client_updates.safe_artifact_path(release.artifact_path)
        assert path.is_file() and path.stat().st_size == release.artifact_size

        deployments._apply_runner_status(run, {
            "state": "running", "result": {"progress": 65}, "log": "building",
        })
        await session.commit()
        await session.refresh(run)
        assert dict(run.result or {})["clientRelease"]["id"] == release_id
        assert dict(run.result or {})["progress"] == 65


async def activate(release_id: str) -> None:
    async with SessionLocal() as session:
        task = await session.get(Task, TASK_ID)
        artifact = await session.get(am.ArtifactVersion, ARTIFACT_ID)
        environment = await session.get(am.Environment, ENV_ID)
        run = await session.get(am.DeploymentRun, RUN_ID)
        run.state = "succeeded"
        await session.flush()
        activated = await deployments._activate_environment_client_releases(
            session, task, artifact, environment)
        await session.commit()
        assert activated == [{"id": release_id, "version": "9.8.7"}]
        release = await session.get(ClientRelease, release_id)
        await session.refresh(run)
        assert release is not None and release.enabled is True
        assert dict(run.result or {})["clientRelease"]["state"] == "active"


async def add_failed_runs() -> tuple[str, str, str]:
    artifact_id = "42000000-0000-4000-8000-000000000015"
    build_run_id = "42000000-0000-4000-8000-000000000016"
    failed_run_id = "42000000-0000-4000-8000-000000000017"
    async with SessionLocal() as session:
        session.add_all([
            am.ArtifactVersion(
                id=artifact_id, task_id=TASK_ID, seq=2, kind="code",
                source_ref="release1.12", commit_sha=COMMIT,
                checksum="c" * 64, state="approved",
            ),
            am.DeploymentRun(
                id=build_run_id, task_id=TASK_ID, artifact_version_id=artifact_id,
                environment_id=ENV_ID, target_id=TARGET_ID, state="running",
                attempt=1, idempotency_key="smoke-client-release-2", commit_sha=COMMIT,
            ),
            am.DeploymentRun(
                id=failed_run_id, task_id=TASK_ID, artifact_version_id=artifact_id,
                environment_id=ENV_ID, target_id=TARGET_ID_2, state="running",
                attempt=1, idempotency_key="smoke-server-release-2", commit_sha=COMMIT,
            ),
        ])
        await session.commit()
    return build_run_id, failed_run_id, artifact_id


async def fail_and_verify_discarded(
    failed_run_id: str, build_run_id: str, release_id: str, stored: Path) -> None:
    async with SessionLocal() as session:
        run = await session.get(am.DeploymentRun, failed_run_id)
        run.state = "failed"
        run.error = "packaging failed"
        await deployments._after_terminal(session, run)
    async with SessionLocal() as session:
        assert await session.get(ClientRelease, release_id) is None
        run = await session.get(am.DeploymentRun, build_run_id)
        assert dict(run.result or {})["clientRelease"]["state"] == "discarded"
        assert not stored.exists()


def main() -> None:
    release_id = str(uuid.uuid4())
    installer, bundle = installer_and_bundle("9.8.7", release_id)
    try:
        asyncio.run(seed())
        with TestClient(app) as client:
            missing = upload(client, RUN_ID, "", installer, bundle)
            assert missing.status_code == 401
            wrong = upload(client, RUN_ID, token("wrong-run"), installer, bundle)
            assert wrong.status_code == 403
            accepted = upload(client, RUN_ID, token(), installer, bundle)
            assert accepted.status_code == 200, accepted.text
            assert accepted.json()["created"] is True
            assert accepted.json()["release"]["state"] == "staged"
            retried = upload(client, RUN_ID, token(), installer, bundle)
            assert retried.status_code == 200, retried.text
            assert retried.json()["created"] is False
            tampered = upload(client, RUN_ID, token(), installer,
                              {**bundle, "notes": "changed after signing"})
            assert tampered.status_code == 409
            invalid_numeric = upload(
                client, RUN_ID, token(), installer, {**bundle, "schema": "broken"})
            assert invalid_numeric.status_code == 409

            asyncio.run(verify_staged(release_id))
            asyncio.run(activate(release_id))
            terminal_retry = upload(client, RUN_ID, token(), installer, bundle)
            assert terminal_retry.status_code == 200, terminal_retry.text
            assert terminal_retry.json()["created"] is False
            assert terminal_retry.json()["release"]["state"] == "active"

            build_run_id, failed_run_id, failed_artifact_id = asyncio.run(
                add_failed_runs())
            failed_release_id = str(uuid.uuid4())
            failed_installer, failed_bundle = installer_and_bundle(
                "9.8.8", failed_release_id)
            failed = upload(
                client, build_run_id,
                token(build_run_id, artifact_id=failed_artifact_id),
                failed_installer, failed_bundle)
            assert failed.status_code == 200, failed.text
            stored = client_updates.safe_artifact_path(
                failed.json()["release"]["channel"] + "/win32/x64/9.8.8/" +
                failed_installer.name)
            assert stored.is_file()
            asyncio.run(fail_and_verify_discarded(
                failed_run_id, build_run_id, failed_release_id, stored))
        print("deployment client release: 32 assertions green")
    finally:
        asyncio.run(engine.dispose())
        shutil.rmtree(TEMP, ignore_errors=True)


if __name__ == "__main__":
    main()
