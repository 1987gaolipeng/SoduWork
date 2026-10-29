"""One authoritative portable Agent/model route resolver."""
from __future__ import annotations


def model_readiness(ctx: dict, kind: str, model: str) -> dict:
    """Validate a workflow model override against the selected portable Agent kind."""
    from . import ai_exec

    kind, model = str(kind or "").strip(), str(model or "").strip()
    if not model:
        return {"ok": True, "model": "", "detail": "跟随底座默认模型"}
    from . import agent_execution_options
    if agent_execution_options.is_native_model_kind(kind):
        return agent_execution_options.validate_native_model(kind, model)
    meta = next((item for item in ai_exec.agent_kinds()
                 if str(item.get("key") or "") == kind), None)
    if meta is not None and meta.get("modelPick") is False:
        return {
            "ok": False, "model": model,
            "detail": f"{meta.get('name') or kind} 的模型由底座自身管理，不能在流程里指定",
        }
    choices = ai_exec.model_choices(ctx)
    allowed = {str(choices.get("default") or "").strip()}
    allowed.update(str(item or "").strip() for item in choices.get("list") or [])
    allowed.discard("")
    if model not in allowed:
        return {
            "ok": False, "model": model,
            "detail": f"模型「{model}」未在当前企业开放的模型清单中",
        }
    return {"ok": True, "model": model, "detail": f"模型「{model}」可用"}


def resolve_sync(ctx: dict, kind: str, client_id: str = "",
                 prefer_runner: str = "", required_capabilities=None,
                 runner_tags=None, fallback_mode: str = "best-effort",
                 model: str = "") -> dict:
    """Resolve one portable route with the same fallback rules everywhere.

    The result is serializable and explains model incompatibilities separately from
    an offline/missing Runner. Callers run this function in a worker thread.
    """
    from . import ai_exec

    requested = str(kind or "").strip()
    fallback_mode = str(fallback_mode or "best-effort").strip().lower()
    candidates = [requested]
    if fallback_mode != "strict":
        candidates.extend(item for item in ai_exec.LOCAL_AGENT_KINDS
                          if item != requested)
    # Runner tags are strict requirements under strict policy and preferences under best-effort policy.
    # Prefer matching tags, then consider other Runners that satisfy the required capabilities.
    # A docker tag may describe a preferred environment rather than a mandatory runtime capability.
    # Treating that preference as a hard requirement can unnecessarily reject available local Runners.
    # Rank fallback choices by tag match first and runtime preference second.
    # Try another runtime while preserving tags before relaxing tags.
    tags = [str(x).strip().lower() for x in (runner_tags or []) if str(x).strip()]
    tag_plans = [tags] + ([[]] if tags and fallback_mode != "strict" else [])
    model_errors: list[str] = []
    for plan_index, plan_tags in enumerate(tag_plans):
        for index, candidate in enumerate(dict.fromkeys(x for x in candidates if x)):
            model_state = model_readiness(ctx, candidate, model)
            if not model_state["ok"]:
                if plan_index == 0:
                    model_errors.append(str(model_state["detail"]))
                continue
            picked = ai_exec.resolve_kind(
                ctx, candidate, client_id,
                prefer_runner if index == 0 else "",
                required_capabilities, plan_tags)
            if picked is not None:
                return {
                    "ok": True, "agent": picked, "requestedKind": requested,
                    "resolvedKind": candidate,
                    "fallbackKind": candidate if candidate != requested else "",
                    "relaxedTags": list(tags) if plan_index > 0 else [],
                    "model": model_state, "modelErrors": model_errors,
                }
    return {
        "ok": False, "agent": None, "requestedKind": requested,
        "resolvedKind": "", "fallbackKind": "",
        "model": model_readiness(ctx, requested, model),
        "modelErrors": list(dict.fromkeys(model_errors)),
    }


__all__ = ["model_readiness", "resolve_sync"]
