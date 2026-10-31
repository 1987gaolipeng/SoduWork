"""Application-owned MCP transport, separate from company connector configuration.

No credential or endpoint supplied by a client becomes a Hub connection. The
immutable installed manifest remains authoritative for every transport binding.
"""
from urllib.parse import urlsplit
import hashlib


def origin(value: str) -> str:
    parsed = urlsplit(str(value or ""))
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("应用连接来源无效")
    host = parsed.hostname.lower()
    if ":" in host:
        host = "[" + host + "]"
    port = parsed.port
    suffix = f":{port}" if port and port != {"http": 80, "https": 443}[parsed.scheme] else ""
    return parsed.scheme + "://" + host + suffix


def sources(manifest: dict) -> list[dict]:
    result = []
    for row in dict(manifest.get("ui") or {}).get("contributions") or []:
        source = dict(row.get("source") or {})
        hosted = source.get('type') == 'package' and (manifest.get('jiyong') or {}).get('mcp', {}).get('server') == 'soduwork-jiyong'
        if (row.get("slot") == "workspace.navigation" and (source.get("type") == "external" or hosted)
                and "mcp.connect" in dict(source.get("bridge") or {}).get("capabilities", [])):
            result.append(row)
    return result


def owned_names(manifest: dict, names) -> set[str]:
    """Infer only the unambiguous legacy one-app/one-connector declaration.

    Multiple connector declarations still require explicit per-turn bindings;
    their company dependencies cannot be silently waived at installation time.
    """
    declared = set(names or [])
    return declared if len(declared) == 1 and sources(manifest) else set()


def company_names(manifest: dict, names) -> list[str]:
    return sorted(set(names or []) - owned_names(manifest, names))


def validate(binding, version) -> str:
    fields = {"pluginId", "versionId", "contributionId", "origin", "server"}
    if not isinstance(binding, dict) or set(binding) != fields or any(
            not isinstance(binding[key], str) or not binding[key] for key in fields):
        raise ValueError("应用连接绑定不完整，请更新客户端并重新打开即用")
    if binding["pluginId"] != version.plugin_id or binding["versionId"] != version.id:
        raise ValueError("应用安装版本已变化，请重新打开即用")
    manifest = dict(version.manifest or {})
    declared = dict(version.capability_report or {}).get("mcpServers") or []
    if binding["server"] not in declared:
        raise ValueError("当前即用版本未声明该 MCP 连接器")
    candidates = [row for row in sources(manifest) if row.get("id") == binding["contributionId"]]
    expected = ''
    if len(candidates) == 1:
        source = candidates[0]['source']
        expected = ('https://' + hashlib.sha256(version.plugin_id.encode()).hexdigest()[:32] + '.soduwork-app.invalid'
                    if source['type'] == 'package' else origin(source['url']))
    if not expected or expected != binding['origin']:
        raise ValueError("应用连接来源或桥权限与已安装版本不一致")
    if candidates[0]['source']['type'] == 'package' and binding['server'] != 'soduwork-jiyong':
        raise ValueError('包内即用只提供其声明的宿主数据 MCP')
    return binding["server"]
