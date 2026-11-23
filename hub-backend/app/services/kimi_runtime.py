"""Host-only Kimi ACP outcome compatibility; installed packages stay read-only."""

from __future__ import annotations

from pathlib import Path


def apply_env(env: dict) -> None:
    loader = Path(__file__).with_name("kimi_acp_outcome.mjs")
    if not loader.is_file():
        raise RuntimeError("Kimi ACP outcome component is missing; update SoduWork")
    # Do not inherit unrelated Node injections into the managed ACP host.
    env["NODE_OPTIONS"] = "--import=" + loader.resolve().as_uri()
    env["SODUWORK_KIMI_ACP_OUTCOME"] = "1"
