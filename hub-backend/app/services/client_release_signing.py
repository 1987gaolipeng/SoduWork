"""Environment-owned signing for authenticated, installer-only publication."""

from __future__ import annotations

import base64
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import stat
import struct
from types import SimpleNamespace
import uuid

from cryptography.hazmat.primitives import serialization
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from . import client_release_files as files
from . import client_updates as contract
from .client_installer_metadata import inspect_installer


logger = logging.getLogger(__name__)


class SigningUnavailable(RuntimeError):
    pass


def _signing_key():
    settings = get_settings()
    path = str(settings.client_update_signing_key_file or "").strip()
    key_id = settings.client_update_signing_key_id
    if not path or not contract.KEY_ID_RE.fullmatch(key_id):
        raise SigningUnavailable("Hub 尚未配置客户端发布签名，请联系管理员")
    try:
        with Path(path).open("rb") as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode) or (
                os.name != "nt" and metadata.st_mode & 0o077
            ):
                raise ValueError(
                    "Signing key must be a restricted regular file (0600/0400)"
                )
            raw = source.read(1025)
            if len(raw) > 1024:
                raise ValueError("Signing key file exceeds 1024 bytes")
        key = contract.private_key(raw.decode("ascii").strip())
        public = base64.b64encode(
            key.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        ).decode("ascii")
        if contract.trusted_public_keys().get(key_id) != public:
            raise ValueError(
                "Configured signing key does not match Hub client update trust"
            )
        return key_id, key
    except Exception as exc:
        raise SigningUnavailable("Hub 客户端发布签名配置不可用，请联系管理员") from exc


def _prepare(installer: Path, channel: str):
    key_id, key = _signing_key()
    try:
        identity = inspect_installer(
            installer, get_settings().client_update_archive_tool
        )
    except (
        ValueError,
        KeyError,
        TypeError,
        IndexError,
        RecursionError,
        struct.error,
        OverflowError,
    ) as exc:
        if isinstance(exc, contract.UpdateContractError):
            raise
        raise contract.UpdateContractError("安装包应用元数据无效") from exc
    selected = channel or os.environ.get("SODUWORK_PUBLIC_DOWNLOAD_CHANNEL", "")
    if not selected:
        selected = "beta" if "-beta." in identity["version"] else "stable"
    if selected not in {"stable", "beta"}:
        raise contract.UpdateContractError("客户端发布通道必须是 stable 或 beta")
    candidate = SimpleNamespace(
        **identity,
        channel=selected,
        artifact_name=installer.name,
        artifact_size=installer.stat().st_size,
        sha256=contract.sha256_file(installer),
        id=str(uuid.uuid4()),
        key_id=key_id,
        notes="",
        mandatory=False,
        min_version="",
        created_at=datetime.now(timezone.utc).replace(microsecond=0),
    )
    if candidate.artifact_size < 1024 * 1024:
        raise contract.UpdateContractError("安装包过小")
    payload = contract.manifest_payload(candidate)
    signature = base64.b64encode(key.sign(contract.canonical_bytes(payload))).decode(
        "ascii"
    )
    return candidate, {**payload, "signature": signature}


async def _existing(session: AsyncSession, candidate):
    row = await contract._find_release(session, candidate)
    if row is None:
        return None
    if row.sha256 != candidate.sha256 or row.artifact_size != candidate.artifact_size:
        raise contract.UpdateContractError(
            "同版本、通道和安装包名称已登记不同内容，请使用新版本"
        )
    contract.assert_trusted_release(row)
    await contract.assert_artifact_integrity_async(row)
    return row


async def register_installer(
    session: AsyncSession, installer: Path, *, channel: str, created_by: str
):
    candidate, bundle = await files.disk_call(_prepare, installer, channel)
    existing = await _existing(session, candidate)
    if existing is not None:
        return existing, False
    try:
        return await contract.import_signed_release(
            session, bundle, installer, enabled=False, created_by=created_by
        )
    except contract.UpdateContractError:
        # Concurrent uploads generate different timestamps/IDs. Reconcile only
        # an identical, trusted artifact; retain its original metadata and state.
        logger.exception(
            "Installer registration collided; checking immutable artifact identity"
        )
        existing = await _existing(session, candidate)
        if existing is not None:
            return existing, False
        raise
