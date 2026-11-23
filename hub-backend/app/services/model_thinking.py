"""Provider-declared reasoning options shared by model capability probes."""

def _off_options(model):
    """Return only supported off switches from the declared provider contract."""
    fmt = model.get("thinkingFormat")
    levels = model.get("thinkingLevelMap") or {}
    if not isinstance(levels, dict) or model.get("kind") == "anthropic":
        return {}
    if fmt in {"zai", "deepseek"}:
        return {"thinking": {"type": "disabled"}}
    if fmt == "qwen":
        return {"enable_thinking": False}
    if fmt == "qwen-chat-template":
        return {"chat_template_kwargs": {"enable_thinking": False, "preserve_thinking": True}}
    if fmt == "openrouter" and levels.get("off", "none") == "none":
        return {"reasoning": {"effort": "none"}}
    if (fmt == "openai" and model.get("supportsReasoningEffort") is True
            and levels.get("off") == "none"):
        return {"reasoning_effort": "none"}
    return {}


def can_disable_reasoning(model):
    """Count reasoning as disabled only when its off request can be sent."""
    levels = model.get("thinkingLevelMap")
    return (model.get("thinkingMode") == "controllable" and model.get("thinkingAlwaysOn") is not True
            and (not isinstance(levels, dict) or "off" not in levels or levels["off"] is not None)
            and bool(_off_options(model)))


def thinking_options(model, *, planning=False):
    """Match declared Pi-compatible thinking formats without model-name guesses."""
    if model.get("reasoning") is not True:
        return {}
    levels = model.get("thinkingLevelMap") or {}
    if not isinstance(levels, dict):
        return {}
    off_allowed = can_disable_reasoning(model)
    level = ("off" if off_allowed else "low") if planning else model.get("thinkingLevel")
    if not level:
        level = "off" if off_allowed else "low" if model.get("thinkingMode") == "always" else ""
    if level == "off" and not off_allowed:
        level = "low"
    fmt = model.get("thinkingFormat")
    result = {}
    if level == "off":
        return _off_options(model)
    effort = levels.get(level)
    if (model.get("supportsReasoningEffort") is True and fmt in {"openai", "zai", "deepseek", "qwen"}
            and isinstance(effort, str) and effort in {"minimal", "low", "medium", "high", "xhigh", "max"}):
        result["reasoning_effort"] = effort
    # Explicit user reasoning selection must enable the declared provider
    # switch; the planning-only low-effort compatibility request stays minimal.
    if not planning and level and level != "off":
        if fmt == "zai":
            result["thinking"] = {"type": "enabled", "clear_thinking": False}
        elif fmt == "deepseek":
            result["thinking"] = {"type": "enabled"}
        elif fmt == "qwen":
            result["enable_thinking"] = True
        elif fmt == "qwen-chat-template":
            result["chat_template_kwargs"] = {"enable_thinking": True, "preserve_thinking": True}
    return result
