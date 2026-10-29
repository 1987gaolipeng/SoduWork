"""Portable platform dependencies; account authorization stays on each device."""
PROVIDERS = {"feishu", "wecom", "dingtalk"}


def normalize(value) -> list[str]:
    if value is None:
        return []
    if (not isinstance(value, list) or len(value) > 3
            or any(not isinstance(key, str) or key not in PROVIDERS for key in value)):
        raise ValueError("平台连接只支持飞书、企业微信和钉钉；其他系统请声明 MCP 或随包 CLI")
    return list(dict.fromkeys(value))


def connector_ready(mcp, runtime, resources, platforms) -> bool:
    return bool(mcp or platforms or (
        "terminal" in runtime and any(item.get("kind") == "script" for item in resources)))
