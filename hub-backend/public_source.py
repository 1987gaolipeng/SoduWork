"""Explicit public distribution boundary, independent of generated archive hashes."""
from __future__ import annotations
import json
from pathlib import Path

INTERNAL_SMOKES = frozenset((
    "smoke_change_hygiene.py", "smoke_smart_route.py", "smoke_gerrit_client.py",
    "smoke_gerrit_flow.py", "smoke_gerrit_merge.py", "smoke_gerrit_attested_merge.py",
    "smoke_gerrit_nodes.py",
    "smoke_release_channels.py", "smoke_rollback.py",
    "smoke_demo_console.py",
))


def is_public_snapshot(root: Path | None = None) -> bool:
    root = root or Path(__file__).resolve().parent.parent
    marker = root / "tools/distribution/PUBLIC-SOURCE.json"
    if not marker.is_file():
        return False
    data = json.loads(marker.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Invalid public source profile")
    if data.get("id") != "opensource-v1":
        return False
    excluded = data.get("excludedFiles")
    if (data.get("schema") != 1 or type(data.get("sourceOnly")) is not bool
            or not isinstance(excluded, list) or any(not isinstance(name, str) for name in excluded)
            or ".gitlab-ci.yml" not in excluded
            or not (root / "hub-backend/quality_manifest.py").is_file()):
        raise ValueError("Invalid public source test profile")
    # A copied profile must not disable internal checks in a full checkout.
    return not (root / ".gitlab-ci.yml").exists()
