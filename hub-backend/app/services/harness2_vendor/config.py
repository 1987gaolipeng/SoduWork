"""SoduWork's minimal, side-effect-free configuration for the vendored core.

This replaces upstream deployment configuration; see UPSTREAM.md. It neither
reads .env files nor selects a model, network endpoint, or external executable.
"""
PHASE_WIDTH = 1
TRANSPORT_ATTEMPTS = 1
DEFAULT_PROPOSER_CHANNEL = "opencode"
PROPOSER_MODEL_BY_CHANNEL = {"opencode": "", "claude_cli": ""}
