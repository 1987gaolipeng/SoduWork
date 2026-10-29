"""Portable, auditable execution options for native CLI agents.

Company-gateway agents (Pi/OpenCode) get their model from ``cfg.llm``. Native
commercial CLIs own their account, but some expose safe per-run model controls.
Keep that distinction in one place so workflow validation, Runner dispatch and
command construction cannot silently disagree.
"""
from __future__ import annotations

import re

from ..agent_catalog import gateway_model_kinds


CODEX_KIND = "local:codex"
# Keep one collection identity: local ACP registration updates the same view
# already imported by execution/model consumers, without restarting sessions.
GATEWAY_MODEL_KINDS = set(gateway_model_kinds())
CODEX_REASONING_EFFORTS = (
    "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
)
_SAFE_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}")


def is_native_model_kind(kind: str) -> bool:
    return str(kind or "").strip().lower() == CODEX_KIND


def supports_soduwork_model_kind(kind: str) -> bool:
    """Whether SoduWork may select and inject a model for this Agent kind."""
    kind = str(kind or "").strip().lower()
    return kind == CODEX_KIND or kind in GATEWAY_MODEL_KINDS


def validate_runtime_model(kind: str, model: str) -> dict:
    """Validate the credential-free model name carried to a Runner.

    Company-gateway agents are already checked against the organization's
    model catalog by ``agent_route_selection``.  This boundary only rejects
    malformed values while preserving model ids that legitimately contain a
    provider prefix such as ``vendor/model``.
    """
    kind, model = str(kind or "").strip().lower(), str(model or "").strip()
    if not model:
        return {"ok": True, "model": "", "detail": "use agent default model"}
    if kind == CODEX_KIND:
        return validate_native_model(kind, model)
    if kind not in GATEWAY_MODEL_KINDS:
        return {"ok": False, "model": model,
                "detail": "this agent does not support a SoduWork-selected model"}
    if len(model) > 160 or any(ord(char) < 32 for char in model):
        return {"ok": False, "model": model, "detail": "invalid gateway model name"}
    return {"ok": True, "model": model,
            "detail": f"gateway model {model} is available"}


def validate_native_model(kind: str, model: str) -> dict:
    """Return a serializable readiness result for a native per-run model."""
    kind, model = str(kind or "").strip().lower(), str(model or "").strip()
    if not model:
        return {"ok": True, "model": "", "detail": "use agent default model"}
    if kind != CODEX_KIND:
        return {"ok": False, "model": model,
                "detail": "this agent does not support a SoduWork-selected model"}
    if not _SAFE_MODEL.fullmatch(model):
        return {"ok": False, "model": model, "detail": "invalid Codex model name"}
    return {"ok": True, "model": model, "detail": f"Codex model {model} is available"}


def normalize_reasoning_effort(value: str, *, allow_empty: bool = True) -> str:
    effort = str(value or "").strip().lower()
    if not effort and allow_empty:
        return ""
    if effort not in CODEX_REASONING_EFFORTS:
        raise ValueError("invalid Codex reasoning effort")
    return effort


def runtime_options(kind: str, model: str = "", reasoning_effort: str = "") -> dict:
    """Validate and return the small, credential-free packet sent to a Runner."""
    kind = str(kind or "").strip().lower()
    model_state = validate_runtime_model(kind, model)
    if model and not model_state["ok"]:
        raise ValueError(str(model_state["detail"]))
    effort = normalize_reasoning_effort(reasoning_effort)
    if effort and kind != CODEX_KIND:
        raise ValueError("only Codex supports a SoduWork-selected reasoning effort")
    out = {"kind": kind}
    if model:
        out["model"] = str(model).strip()
    if effort:
        out["reasoningEffort"] = effort
    return out


__all__ = [
    "CODEX_KIND", "CODEX_REASONING_EFFORTS", "GATEWAY_MODEL_KINDS",
    "is_native_model_kind", "normalize_reasoning_effort", "runtime_options",
    "supports_soduwork_model_kind", "validate_native_model", "validate_runtime_model",
]
