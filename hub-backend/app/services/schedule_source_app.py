"""Bounded display metadata, separate from execution and account identity."""

def clean(raw):
    if raw is None or raw == {}:
        return {}
    if not isinstance(raw, dict) or set(raw) - {"pluginId", "key", "name", "icon", "characterName"}:
        raise ValueError("即用展示信息格式无效")
    result = {}
    for key, limit in (("pluginId",160),("key",64),("name",200),("characterName",120)):
        value = raw.get(key, "")
        if not isinstance(value,str) or len(value)>limit or any(ord(c)<32 for c in value):
            raise ValueError("即用展示信息长度或格式无效")
        result[key] = value.strip()
    if not result["pluginId"] or not result["name"]:
        raise ValueError("即用展示信息缺少标识或名称")
    from .plugin_icons import normalize
    result["icon"] = normalize(raw.get("icon", ""))
    return result
