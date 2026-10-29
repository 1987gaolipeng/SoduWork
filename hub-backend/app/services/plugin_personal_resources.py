"""Keep imported plugin files inert across native personal round trips."""
from __future__ import annotations

import hashlib

from . import plugin_package_resources, plugin_resources


def discovery_files(names: dict, manifest: dict, prefix: str) -> dict:
    """Declared attachment SKILL.md files are resources, not new top-level skills.

    Resource paths, hashes and bytes are still validated by from_archive later.
    A declaration cannot hide the top-level Skill, since resource roots are limited.
    """
    raw = manifest.get("resources")
    if not isinstance(raw, list):
        return names
    base = prefix + "skills/" + str(manifest.get("key") or "") + "/"
    declared = {
        base + str(row.get("path") or "")
        for row in raw
        if isinstance(row, dict)
        # Skill Studio keeps its bundled Agent Skill under references/source.
        # Leave that one SKILL.md visible so its name and description metadata
        # survive import; platform packages keep their declared top-level
        # skills as resources and must not rediscover them as duplicates.
        and str(row.get("path") or "").replace("\\", "/") not in
        {"references/source/SKILL.md"}
    }
    return {name: info for name, info in names.items() if name not in declared}


def prepare(parsed: dict, instructions: str) -> tuple[list, str]:
    manifest = dict(parsed.get("manifest") or {})
    report = dict(parsed.get("capabilities") or {})
    original = str(manifest.get("instructions") or "")
    resources = list(parsed.get("resources") or [])
    portable = parsed.get("sourceKind") in {"codex", "claude", "agent-plugins"}
    bundle = None
    if portable or (report.get("bundledSkills") and not resources):
        bundle = parsed.get("resourceBundle") or plugin_package_resources.build(parsed)
        resources = bundle["resources"]
        # A generated native package containing only its own Skill already has
        # its complete instructions. Preserve that established editing contract.
        if portable or len(resources) > 1 or not original:
            instructions = original + "\n\n" + plugin_package_resources.index(bundle)
        else:
            instructions = original
    elif original:
        instructions = original
    if len(instructions) > 8000:
        # The editor has an 8K text limit; retain full content as a normal file.
        content = original if original else instructions
        digest = hashlib.sha256(content.encode("utf8")).hexdigest()[:16]
        path = "references/imported-instructions-" + digest + ".md"
        resources = plugin_resources.normalize(resources + [{
            "path": path, "kind": "reference", "encoding": "utf8", "content": content,
        }])
        instructions = "请完整读取随包资源 " + path + "，按其中工作方法和验收标准完成当前请求。"
        if bundle and len(bundle["resources"]) > 1:
            instructions += "\n\n" + plugin_package_resources.index(bundle)
    return resources, instructions
