"""Detached Ed25519 signatures and trusted plugin publishers.

The signature file lives inside the archive at ``soduwork/signature.json`` but is
excluded from the signed content digest.  This avoids a self-referential hash
while keeping the original archive checksum as the immutable package identity.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .client_updates import canonical_bytes

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from .. import automation_models as am


SIGNATURE_PATH = "soduwork/signature.json"
SCHEMA = "soduwork.plugin-signature/v1"
ALGORITHM = "Ed25519"
KEY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")
SIGNATURE_STATES = {
    "unsigned", "unknown-key", "revoked-key", "invalid", "verified", "platform",
}


def _decode(value: str, length: int, label: str) -> bytes:
    try:
        raw = base64.b64decode(str(value or "").strip(), validate=True)
    except Exception as exc:
        raise ValueError(f"{label}不是合法 Base64") from exc
    if len(raw) != length:
        raise ValueError(f"{label}必须是 {length} 字节")
    return raw


def normalize_public_key(value: str) -> tuple[str, str]:
    raw = _decode(value, 32, "Ed25519 公钥")
    key = Ed25519PublicKey.from_public_bytes(raw)
    canonical = base64.b64encode(key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )).decode("ascii")
    return canonical, hashlib.sha256(raw).hexdigest()


def signature_payload(content_checksum: str, manifest: dict, envelope: dict) -> dict:
    return {
        "schema": SCHEMA,
        "algorithm": ALGORITHM,
        "keyId": str(envelope.get("keyId") or ""),
        "contentChecksum": str(content_checksum or ""),
        "pluginKey": str(manifest.get("key") or ""),
        "version": str(manifest.get("version") or ""),
        "signedAt": str(envelope.get("signedAt") or ""),
    }


def prepare_payload(parsed: dict, key_id: str, signed_at: str) -> dict:
    clean_key = str(key_id or "").strip()
    clean_time = str(signed_at or "").strip()[:40]
    if not KEY_ID_RE.fullmatch(clean_key):
        raise ValueError("插件签名 keyId 不合法")
    try:
        datetime.fromisoformat(clean_time.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("插件签名时间不是有效 ISO 8601") from exc
    return signature_payload(
        str(parsed.get("contentChecksum") or ""),
        dict(parsed.get("manifest") or {}),
        {"keyId": clean_key, "signedAt": clean_time})


def parse_envelope(raw: bytes | None, content_checksum: str, manifest: dict) -> dict:
    if raw is None:
        return {}
    if len(raw) > 8192:
        raise ValueError("插件签名清单不能超过 8KB")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("插件签名清单不是有效的 UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("插件签名清单必须是对象")
    schema = str(value.get("schema") or "")
    algorithm = str(value.get("algorithm") or "")
    key_id = str(value.get("keyId") or "")
    signed_at = str(value.get("signedAt") or "")[:40]
    signature = str(value.get("signature") or "")
    if schema != SCHEMA or algorithm != ALGORITHM:
        raise ValueError("插件签名协议或算法不受支持")
    if not KEY_ID_RE.fullmatch(key_id):
        raise ValueError("插件签名 keyId 不合法")
    _decode(signature, 64, "插件签名")
    envelope = {
        "schema": schema, "algorithm": algorithm, "keyId": key_id,
        "signedAt": signed_at, "signature": signature,
    }
    envelope["payload"] = signature_payload(content_checksum, manifest, envelope)
    return envelope


def public_signature(value: dict | None, state: str = "") -> dict:
    row = dict(value or {})
    current = state or ("present" if row else "unsigned")
    return {
        "present": bool(row),
        "state": current,
        "algorithm": str(row.get("algorithm") or "")[:20],
        "keyId": str(row.get("keyId") or "")[:64],
        "signedAt": str(row.get("signedAt") or "")[:40],
        "contentChecksum": str(dict(row.get("payload") or {}).get(
            "contentChecksum") or "")[:64],
    }


def verify_candidate(parsed: dict, value: dict | None, publisher_name: str = "") -> dict:
    """Verify a submitted public-key candidate without trusting it.

    This proves that the submitter controls the private key which signed this
    immutable package. Enterprise trust is still a separate administrator
    action and no private key ever crosses the client boundary.
    """
    candidate = dict(value or {})
    envelope = dict(parsed.get("signature") or {})
    if not envelope:
        raise ValueError("这个插件没有数字签名，不能申请登记发布身份")
    key_id = str(candidate.get("keyId") or "").strip()
    if key_id != str(envelope.get("keyId") or ""):
        raise ValueError("发布者公钥与插件签名 keyId 不一致")
    public_key, fingerprint = normalize_public_key(str(candidate.get("publicKey") or ""))
    claimed = str(candidate.get("fingerprint") or "").strip().lower()
    if claimed and claimed != fingerprint:
        raise ValueError("发布者公钥指纹不一致")
    try:
        signature = _decode(envelope.get("signature"), 64, "插件签名")
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key)).verify(
            signature, canonical_bytes(dict(envelope.get("payload") or {})))
    except Exception as exc:
        raise ValueError("发布者公钥无法验证这个插件包的数字签名") from exc
    return {
        "keyId": key_id,
        "publicKey": public_key,
        "fingerprint": fingerprint,
        "publisherName": str(publisher_name or candidate.get("publisherName") or
                             "个人插件发布者").strip()[:120],
    }


def publisher_candidate(version: am.PluginVersion) -> dict:
    """Management-only candidate details stored with a quarantined version."""
    row = dict(dict(version.provenance or {}).get("_publisherCandidate") or {})
    if not row:
        return {}
    return {
        "versionId": version.id,
        "keyId": str(row.get("keyId") or "")[:64],
        "publicKey": str(row.get("publicKey") or "")[:64],
        "fingerprint": str(row.get("fingerprint") or "")[:64],
        "publisherName": str(row.get("publisherName") or "个人插件发布者")[:120],
    }


def key_api(row: am.PluginPublisherKey) -> dict:
    return {
        "id": row.id,
        "orgId": row.org_id,
        "keyId": row.key_id,
        "publisherName": row.publisher_name,
        "description": row.description or "",
        "fingerprint": row.fingerprint,
        "status": row.status,
        "createdBy": row.created_by or "",
        "createdAt": int(row.created_at.timestamp() * 1000) if row.created_at else None,
        "revokedAt": int(row.revoked_at.timestamp() * 1000) if row.revoked_at else None,
    }


async def inspect(session: AsyncSession, parsed: dict, org_id: str | None) -> dict:
    from sqlalchemy import select
    from .. import automation_models as am

    envelope = dict(parsed.get("signature") or {})
    if not envelope:
        return {"state": "unsigned", **public_signature(None, "unsigned")}
    key_id = str(envelope.get("keyId") or "")
    row = None
    if org_id is not None:
        row = await session.scalar(select(am.PluginPublisherKey).where(
            am.PluginPublisherKey.key_id == key_id,
            am.PluginPublisherKey.org_id == org_id,
        ).limit(1))
    if row is None:
        row = await session.scalar(select(am.PluginPublisherKey).where(
            am.PluginPublisherKey.key_id == key_id,
            am.PluginPublisherKey.org_id.is_(None),
        ).limit(1))
    base = {**public_signature(envelope), "publisherKeyId": row.id if row else ""}
    if row is None:
        return {**base, "state": "unknown-key"}
    if row.status != "active":
        return {**base, "state": "revoked-key", "publisherName": row.publisher_name,
                "fingerprint": row.fingerprint}
    try:
        signature = _decode(envelope.get("signature"), 64, "插件签名")
        public_raw = _decode(row.public_key, 32, "发布者公钥")
        Ed25519PublicKey.from_public_bytes(public_raw).verify(
            signature, canonical_bytes(dict(envelope.get("payload") or {})))
    except Exception:
        return {**base, "state": "invalid", "publisherName": row.publisher_name,
                "fingerprint": row.fingerprint}
    return {
        **base, "state": "verified", "publisherName": row.publisher_name,
        "publisherId": row.id, "publisherType": "trusted-publisher",
        "fingerprint": row.fingerprint,
    }


def assert_importable(proof: dict) -> None:
    state = str(proof.get("state") or "unsigned")
    if state == "invalid":
        raise ValueError("插件数字签名无效，内容可能已被篡改")
    if state == "revoked-key":
        raise ValueError("插件使用的发布者密钥已撤销")


def assert_publishable(proof: dict) -> None:
    if proof.get("present") and proof.get("state") != "verified":
        if proof.get("state") == "unknown-key":
            raise ValueError("插件签名的发布者尚未登记，不能发布")
        assert_importable(proof)


async def create_key(session: AsyncSession, body: dict, user, org_id: str | None) -> am.PluginPublisherKey:
    from sqlalchemy import select
    from .. import automation_models as am

    key_id = str(body.get("keyId") or "").strip()
    publisher = str(body.get("publisherName") or "").strip()[:120]
    description = str(body.get("description") or "").strip()[:400]
    if not KEY_ID_RE.fullmatch(key_id):
        raise ValueError("发布者 keyId 需为 3-64 位字母、数字、点、横线或下划线")
    if not publisher:
        raise ValueError("请填写发布者名称")
    public_key, fingerprint = normalize_public_key(str(body.get("publicKey") or ""))
    scoped = await session.scalar(select(am.PluginPublisherKey.id).where(
        am.PluginPublisherKey.key_id == key_id,
        (am.PluginPublisherKey.org_id == org_id
         if org_id is not None else am.PluginPublisherKey.org_id.is_(None)),
    ).limit(1))
    if scoped:
        raise ValueError("这个发布者 keyId 已存在；密钥轮换请使用新的 keyId")
    other_public_keys = (await session.scalars(select(am.PluginPublisherKey.public_key).where(
        am.PluginPublisherKey.key_id == key_id,
    ))).all()
    if any(value != public_key for value in other_public_keys):
        raise ValueError("这个发布者 keyId 已绑定另一把公钥")
    row = am.PluginPublisherKey(
        org_id=org_id, key_id=key_id, publisher_name=publisher,
        description=description, public_key=public_key, fingerprint=fingerprint,
        status="active", created_by=str(getattr(user, "id", "") or "")[:64],
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def register_candidate(session: AsyncSession, version: am.PluginVersion,
                             plugin: am.Plugin, user, body: dict):
    """Explicitly trust the verified public key attached to one submission.

    The candidate was proof-of-possession checked at upload time. We repeat
    that check against the immutable stored package before creating trust.
    """
    from sqlalchemy import select
    from .. import automation_models as am
    from . import plugin_packages

    candidate = publisher_candidate(version)
    if not candidate:
        raise ValueError("这个版本没有可登记的发布者公钥")
    if version.trust_state != "quarantined":
        raise ValueError("只有隔离待审版本可以登记提交时的发布身份")
    if not version.package_path or not os.path.isfile(version.package_path):
        raise ValueError("插件原始包已缺失，不能核对发布身份")
    from . import file_io
    parsed = await file_io.run(plugin_packages.parse_file, version.package_path)
    if parsed.get("checksum") != version.checksum:
        raise ValueError("插件包内容与不可变版本不一致")
    verified = verify_candidate(parsed, candidate)

    rows = (await session.scalars(select(am.PluginPublisherKey).where(
        am.PluginPublisherKey.key_id == verified["keyId"]
    ))).all()
    if any(row.public_key != verified["publicKey"] for row in rows):
        raise ValueError("这个发布者 keyId 已绑定另一把公钥")
    scoped = next((row for row in rows if row.org_id == plugin.org_id), None)
    platform = next((row for row in rows if row.org_id is None), None)
    if plugin.org_id is None and platform is None and rows:
        raise ValueError("这个发布者 keyId 已在组织范围登记，不能自动提升为平台发布者")
    existing = scoped or (platform if plugin.org_id is not None else None)
    if existing is not None:
        if existing.status != "active":
            raise ValueError("这个发布者密钥已经撤销，不能重新信任")
        row = existing
    else:
        row = await create_key(session, {
            "keyId": verified["keyId"],
            "publisherName": str(body.get("publisherName") or
                                 candidate.get("publisherName") or "个人插件发布者"),
            "description": str(body.get("description") or
                               "由个人插件提交申请，经管理员核对登记"),
            "publicKey": verified["publicKey"],
        }, user, plugin.org_id)

    proof = await inspect(session, parsed, plugin.org_id)
    if proof.get("state") != "verified":
        raise ValueError("发布者登记后仍无法验证插件签名")
    provenance = dict(version.provenance or {})
    provenance.pop("_publisherCandidate", None)
    provenance.update({
        "publisherId": proof.get("publisherId"),
        "publisherName": proof.get("publisherName"),
        "publisherType": proof.get("publisherType"),
        "signatureState": proof.get("state"),
        "signatureKeyId": proof.get("keyId"),
        "signatureFingerprint": proof.get("fingerprint"),
        "signatureSignedAt": proof.get("signedAt"),
    })
    version.provenance = provenance
    await session.commit()
    return row, proof


async def revoke_key(session: AsyncSession, row: am.PluginPublisherKey) -> None:
    """Revoke future trust without silently stopping already published work.

    Published plugin versions have their own explicit revoke action and audit
    trail. Keeping these two decisions separate avoids one key-management click
    unexpectedly disabling production bindings.
    """
    row.status = "revoked"
    row.revoked_at = datetime.now(timezone.utc)
    await session.commit()
