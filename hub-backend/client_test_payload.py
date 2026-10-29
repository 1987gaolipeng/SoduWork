"""Locate the public self-hosted Client build for native packaging smoke checks."""
from __future__ import annotations

import json
import os
from pathlib import Path

CLIENT = Path(__file__).resolve().parents[1] / "client"
PROFILE = "self-hosted"


def windows_payload(distribution: str | None = None) -> tuple[Path, Path, Path]:
    selected = distribution if distribution is not None else os.environ.get(
        "SODUWORK_DISTRIBUTION", PROFILE)
    if selected != PROFILE:
        raise ValueError(f"Unknown public Client distribution: {selected}")
    package = json.loads((CLIENT / "package.json").read_text(encoding="utf-8"))
    build = package.get("build", {})
    output = Path(build.get("directories", {}).get("output", "dist"))
    if output.is_absolute() or ".." in output.parts:
        raise ValueError("Public Client build output must stay inside the Client directory")
    product = package.get("productName") or build.get("productName") or "SoduWork"
    executable_name = build.get("win", {}).get("executableName") or product
    if not isinstance(executable_name, str) or not executable_name or any(
            separator in executable_name for separator in ("/", chr(92), ":")):
        raise ValueError("Invalid public Windows executable name")
    payload = CLIENT / output / "win-unpacked"
    return payload, payload / (executable_name + ".exe"), payload / "resources" / "shell"
