"""Explicit public source snapshot boundary; never infer it from a missing file."""
from __future__ import annotations
import json
from pathlib import Path

INTERNAL_SMOKES = frozenset((
    "smoke/smoke_change_hygiene.py", "smoke/smoke_smart_route.py", "smoke/smoke_gerrit_client.py",
    "smoke/smoke_gerrit_flow.py", "smoke/smoke_gerrit_merge.py", "smoke/smoke_gerrit_attested_merge.py",
    "smoke/smoke_gerrit_nodes.py",
    "smoke/smoke_release_channels.py", "smoke/smoke_rollback.py",
    "smoke/smoke_demo_console.py",
))


def is_public_snapshot(root: Path | None = None) -> bool:
    root = root or Path(__file__).resolve().parent.parent
    marker = root / "tools/distribution/SOURCE-MANIFEST.json"
    if not marker.is_file():
        return False
    data = json.loads(marker.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Invalid public source manifest")
    if data.get("distribution") != "public-source":
        return False
    if not isinstance(data.get("files"), list):
        raise ValueError("Invalid public source inventory")
    paths = {entry.get("path") for entry in data.get("files", ()) if isinstance(entry, dict)}
    if (data.get("schema") != 1 or data.get("ok") is not True
            or "hub-backend/quality_manifest.py" not in paths):
        raise ValueError("Invalid public source test profile")
    return True
