"""Verify and import an offline-signed immutable SoduWork client release bundle."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select

from app.db import SessionLocal
from app.models import ClientRelease
from app.services import client_updates as updates


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import an offline-signed client release")
    parser.add_argument("bundle")
    parser.add_argument("installer")
    return parser.parse_args()


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _release_from_bundle(bundle: dict) -> SimpleNamespace:
    artifact = bundle.get("artifact") if isinstance(bundle.get("artifact"), dict) else {}
    published = _text(bundle.get("publishedAt"), 64)
    try:
        created_at = datetime.fromisoformat(published.replace("Z", "+00:00"))
    except Exception as exc:
        raise SystemExit("bundle publishedAt is invalid") from exc
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return SimpleNamespace(
        id=_text(bundle.get("releaseId"), 36),
        version=_text(bundle.get("version"), 32),
        channel=_text(bundle.get("channel") or "stable", 16),
        platform=_text(bundle.get("platform") or "win32", 16),
        arch=_text(bundle.get("arch") or "x64", 16),
        artifact_name=_text(artifact.get("name"), 160),
        artifact_path="",
        artifact_size=int(artifact.get("size") or 0),
        sha256=_text(artifact.get("sha256"), 64).lower(),
        signature=_text(bundle.get("signature"), 128),
        key_id=_text(bundle.get("keyId"), 64),
        notes=_text(bundle.get("notes"), 20000),
        mandatory=bool(bundle.get("mandatory")),
        min_version=_text(bundle.get("minVersion"), 32),
        enabled=True,
        created_by="offline-signed",
        created_at=created_at.astimezone(timezone.utc),
    )


async def import_release(args: argparse.Namespace) -> ClientRelease:
    source = Path(args.installer).resolve()
    bundle_path = Path(args.bundle).resolve()
    if not source.is_file() or source.suffix.lower() != ".exe":
        raise SystemExit("installer must be an existing .exe")
    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit("bundle is not valid UTF-8 JSON") from exc
    if not isinstance(bundle, dict) or int(bundle.get("schema") or 0) != 1:
        raise SystemExit("unsupported bundle schema")
    candidate = _release_from_bundle(bundle)
    try:
        uuid.UUID(candidate.id)
    except Exception as exc:
        raise SystemExit("release id is invalid") from exc
    if updates.parse_version(candidate.version) is None:
        raise SystemExit("release version is invalid")
    if candidate.min_version and updates.parse_version(candidate.min_version) is None:
        raise SystemExit("minimum version is invalid")
    if candidate.channel not in {"stable", "beta"}:
        raise SystemExit("release channel is invalid")
    if candidate.platform != "win32" or candidate.arch not in {"x64", "arm64"}:
        raise SystemExit("release target is invalid")
    if candidate.artifact_name not in updates._expected_installer_names(
            candidate.platform, candidate.arch, candidate.version):
        raise SystemExit("installer name does not match release version")
    if source.name != candidate.artifact_name:
        raise SystemExit("installer filename does not match signed bundle")
    if candidate.artifact_size < 1024 * 1024:
        raise SystemExit("installer is too small")
    if source.stat().st_size != candidate.artifact_size:
        raise SystemExit("installer size does not match signed bundle")
    if updates.sha256_file(source) != candidate.sha256:
        raise SystemExit("installer digest does not match signed bundle")
    payload = updates.assert_trusted_release(candidate)
    if bundle != {**payload, "signature": candidate.signature}:
        raise SystemExit("bundle contains unsigned or unknown fields")

    relative = (
        f"{candidate.channel}/{candidate.platform}/{candidate.arch}/"
        f"{candidate.version}/{candidate.artifact_name}"
    )
    target = updates.safe_artifact_path(relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise SystemExit("immutable client artifact already exists")
    temp = target.with_suffix(target.suffix + ".tmp")
    shutil.copyfile(source, temp)
    artifact_created = False
    row = ClientRelease(
        id=candidate.id,
        version=candidate.version,
        channel=candidate.channel,
        platform=candidate.platform,
        arch=candidate.arch,
        artifact_name=candidate.artifact_name,
        artifact_path=relative,
        artifact_size=candidate.artifact_size,
        sha256=candidate.sha256,
        signature=candidate.signature,
        key_id=candidate.key_id,
        notes=candidate.notes,
        mandatory=candidate.mandatory,
        min_version=candidate.min_version,
        enabled=True,
        created_by=candidate.created_by,
        created_at=candidate.created_at,
    )
    async with SessionLocal() as session:
        existing_id = await session.get(ClientRelease, row.id)
        existing_version = (await session.execute(select(ClientRelease.id).where(
            ClientRelease.channel == row.channel,
            ClientRelease.platform == row.platform,
            ClientRelease.arch == row.arch,
            ClientRelease.version == row.version,
        ))).scalar_one_or_none()
        if existing_id or existing_version:
            temp.unlink(missing_ok=True)
            raise SystemExit("immutable client release already exists")
        session.add(row)
        try:
            os.link(temp, target)
            artifact_created = True
            temp.unlink()
            await session.commit()
        except Exception:
            temp.unlink(missing_ok=True)
            if artifact_created:
                target.unlink(missing_ok=True)
            raise
        await session.refresh(row)
    return row


async def main() -> None:
    row = await import_release(arguments())
    print(f"imported {row.version} {row.channel}/{row.platform}/{row.arch}")
    print(f"artifact {row.artifact_name} {row.artifact_size} bytes sha256={row.sha256}")
    print(f"release_id {row.id} key_id={row.key_id}")


if __name__ == "__main__":
    asyncio.run(main())
