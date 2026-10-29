"""Builtin plugin provenance gates; stored display text is served verbatim."""
from __future__ import annotations

import json
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name("brand_catalog_v1.json").read_text(encoding="utf-8"))


def builtin_plugin(plugin) -> bool:
    return (getattr(plugin, "org_id", "unknown") is None and getattr(plugin, "source_kind", "") == "builtin"
            and getattr(plugin, "created_by", "") == "system" and getattr(plugin, "key", "") in CATALOG)


def builtin_version(version) -> bool:
    proof = dict(version.provenance or {})
    manifest = dict(version.manifest or {})
    return (getattr(version, "created_by", "") == "system" and manifest.get("key") in CATALOG
            and proof.get("publisherType") == "platform"
            and proof.get("channel") == "builtin"
            and proof.get("signatureState") == "platform")


def manifest_display(version) -> dict:
    """Copy only UI metadata; execution instructions, hashes and the stored row stay exact."""
    result = dict(version.manifest or {})
    if builtin_version(version):
        for field in ("name", "description", "author"):
            if not isinstance(result.get(field), str):
                result.pop(field, None)
    return result


def publisher_display(proof: dict) -> str:
    return str(proof.get("publisherName") or "未知发布者")
