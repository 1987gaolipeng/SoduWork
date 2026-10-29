"""Non-secret model-definition configuration contracts.

Normalization is independent of provider rows, credential ownership, catalog
bootstrap/migrations and transaction-scoped caches, which stay in model_catalog.
"""
from __future__ import annotations

import json

from . import model_capabilities


MODEL_MODALITIES = ("chat", "image", "video")
MEDIA_ENDPOINTS = {
    "image": "/images/generations",
    "video": "/videos/generations",
}
IMAGE_ROUTINGS = ("auto", "native", "vision-fallback")
THINKING_MODES = ("auto", "always", "controllable", "none")
THINKING_FORMATS = (
    "openai", "openrouter", "deepseek", "together", "baseten", "zai",
    "qwen", "qwen-chat-template", "chat-template", "string-thinking", "ant-ling",
)
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")


def normalize_modality(value: str) -> str:
    modality = str(value or "chat").strip().lower()
    return modality if modality in MODEL_MODALITIES else "chat"


def normalize_image_routing(value: str) -> str:
    """Return the safe image-input route for an OpenAI-compatible chat model.

    A model catalog row does not imply that the upstream model accepts image
    blocks. Unknown rows require a separately enabled adapter; this route
    alone does not authorize a request to a different vision model.
    """
    routing = str(value or "").strip().lower()
    return routing if routing in ("native", "vision-fallback") else "vision-fallback"


def _clean_relative_path(value, label: str, *, require_id: bool = False) -> str:
    path = str(value or "").strip()
    if not path:
        return ""
    if len(path) > 240:
        raise ValueError(f"{label}不能超过 240 个字符")
    if (not path.startswith("/") or path.startswith("//")
            or "://" in path or ".." in path):
        raise ValueError(f"{label}必须是同一模型服务下的相对路径")
    rest = path.replace("{id}", "")
    if "{" in rest or "}" in rest:
        raise ValueError(f"{label}包含不支持的路径变量")
    if require_id and path.count("{id}") != 1:
        raise ValueError(f"{label}必须包含一个 {{id}}，用于代入生成任务 ID")
    return path


def _clean_thinking_config(value) -> dict:
    """Normalize the provider/model thinking contract.

    ``always`` is deliberately represented with Pi's native
    ``thinkingLevelMap.off = null``.  That makes the client clamp its default
    "off" selection to the first supported thinking level and prevents it from
    sending a provider-side disable request for models that cannot turn
    reasoning off.
    """
    raw = value if isinstance(value, dict) else {}
    keys = {"thinkingMode", "thinkingAlwaysOn", "thinkingFormat",
            "supportsReasoningEffort", "thinkingLevelMap", "reasoning"}
    if not any(key in raw for key in keys):
        return {}

    mode_value = raw.get("thinkingMode")
    if mode_value is None and raw.get("thinkingAlwaysOn") is True:
        mode_value = "always"
    mode = str(mode_value or "auto").strip().lower()
    if mode not in THINKING_MODES:
        raise ValueError("思考模式必须是自动、始终开启、可控制或关闭")

    fmt = str(raw.get("thinkingFormat") or "").strip().lower()
    if fmt and fmt not in THINKING_FORMATS:
        raise ValueError("思考参数格式不受支持")

    out = {"thinkingMode": mode}
    if fmt:
        out["thinkingFormat"] = fmt
    if isinstance(raw.get("supportsReasoningEffort"), bool):
        out["supportsReasoningEffort"] = raw["supportsReasoningEffort"]

    level_map = raw.get("thinkingLevelMap")
    if level_map is not None:
        if not isinstance(level_map, dict):
            raise ValueError("思考级别映射必须是 JSON 对象")
        clean_map = {}
        for key, mapped in level_map.items():
            level = str(key).strip().lower()
            if level not in THINKING_LEVELS:
                raise ValueError("思考级别映射包含无效级别")
            if mapped is not None and (not isinstance(mapped, str) or not mapped.strip()):
                raise ValueError("思考级别映射的值必须是字符串或 null")
            clean_map[level] = mapped.strip() if isinstance(mapped, str) else None
        if clean_map:
            out["thinkingLevelMap"] = clean_map

    if isinstance(raw.get("reasoning"), bool):
        out["reasoning"] = raw["reasoning"]
    elif mode == "always" or mode == "controllable":
        out["reasoning"] = True
    elif mode == "none":
        out["reasoning"] = False

    if mode == "always":
        out.setdefault("thinkingLevelMap", {})["off"] = None
        out["reasoning"] = True
    elif mode == "none":
        out.pop("thinkingLevelMap", None)
        out["reasoning"] = False
    return out


def clean_model_config(value, modality: str = "chat") -> dict:
    """Validate the small, non-secret per-model generation contract."""
    modality = normalize_modality(modality)
    raw = dict(value) if isinstance(value, dict) else {}
    thinking = _clean_thinking_config(raw) if modality == "chat" else {}
    image_routing = ""
    if modality == "chat" and "imageRouting" in raw:
        image_routing = str(raw.get("imageRouting") or "").strip().lower()
        if image_routing not in IMAGE_ROUTINGS:
            raise ValueError("图片输入方式必须是自动、原生识图或视觉辅助")
    endpoint = _clean_relative_path(raw.get("endpointPath"), "生成接口路径")
    if not endpoint and modality in MEDIA_ENDPOINTS:
        endpoint = MEDIA_ENDPOINTS[modality]
    status_path = _clean_relative_path(
        raw.get("statusPath"), "任务查询路径", require_id=True)
    result_path = _clean_relative_path(
        raw.get("resultPath"), "结果下载路径", require_id=True)
    if modality != "video" and (status_path or result_path):
        raise ValueError("只有视频生成模型可以配置异步任务路径")
    defaults = raw.get("defaults")
    if defaults is None:
        defaults = {}
    if not isinstance(defaults, dict):
        raise ValueError("默认参数必须是 JSON 对象")
    defaults = {
        str(key)[:80]: item
        for key, item in defaults.items()
        if str(key) not in {"model", "stream"}
    }
    try:
        encoded = json.dumps(defaults, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("默认参数必须是合法 JSON") from exc
    if len(encoded.encode("utf-8")) > 12000:
        raise ValueError("默认参数不能超过 12 KB")
    out = dict(thinking)
    if modality == "chat":
        out.update(model_capabilities.clean_config(raw))
    if endpoint or defaults or modality in MEDIA_ENDPOINTS:
        out.update({"endpointPath": endpoint, "defaults": defaults})
    if image_routing:
        out["imageRouting"] = image_routing
    if status_path:
        out["statusPath"] = status_path
    if result_path:
        out["resultPath"] = result_path
    return out if out else {}

def model_config(value, modality: str = "chat") -> dict:
    """Read legacy or manually edited rows without breaking the catalog."""
    try:
        return clean_model_config(value, modality)
    except ValueError:
        return clean_model_config({}, modality)
