"""Public per-turn plugin badges; never persist instructions or grants here."""


def badges(value) -> list[dict]:
    items, seen = [], set()
    for row in value if isinstance(value, list) else []:
        if not isinstance(row, dict):
            continue
        plugin_id = str(row.get("pluginId") or "").strip()[:160]
        if not plugin_id or plugin_id in seen:
            continue
        seen.add(plugin_id)
        items.append({"pluginId": plugin_id,
                      "name": str(row.get("name") or "")[:120],
                      "version": str(row.get("version") or "")[:40],
                      "scopeLabel": str(row.get("scopeLabel") or "")[:120]})
        if len(items) >= 3:
            break
    return items
