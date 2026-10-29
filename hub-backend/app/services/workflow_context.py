"""Build a bounded, auditable handoff between workflow nodes."""
from __future__ import annotations

import hashlib
import json

from . import workflow_contracts


_MAX_DEPTH = 6
_MAX_ITEMS = 40
_MAX_STRING = 2400
_MAX_PROMPT = 24000


def _bounded(value, depth: int = 0):
    """Keep dependency output useful without letting one node flood the next prompt."""
    if depth >= _MAX_DEPTH:
        return "[content omitted: nesting limit]"
    if isinstance(value, dict):
        return {str(key)[:160]: _bounded(item, depth + 1)
                for key, item in list(value.items())[:_MAX_ITEMS]}
    if isinstance(value, (list, tuple)):
        return [_bounded(item, depth + 1) for item in list(value)[:_MAX_ITEMS]]
    if isinstance(value, str):
        return value[:_MAX_STRING]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:_MAX_STRING]


def _prompt_bounded(value, max_string: int, max_items: int, depth: int = 0):
    """Compact a handoff without ever cutting serialized JSON in the middle."""
    if depth >= _MAX_DEPTH:
        return "[content omitted: nesting limit]"
    if isinstance(value, dict):
        return {str(key)[:160]: _prompt_bounded(item, max_string, max_items, depth + 1)
                for key, item in list(value.items())[:max_items]}
    if isinstance(value, (list, tuple)):
        return [_prompt_bounded(item, max_string, max_items, depth + 1)
                for item in list(value)[:max_items]]
    if isinstance(value, str):
        return value[:max_string]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:max_string]


def _visible_json(envelope: dict, limit: int) -> tuple[str, bool]:
    raw = json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(raw) <= limit:
        return raw, False
    root_key = next(iter(envelope), "inputs")
    original = dict(envelope.get(root_key) or {})
    for max_string, max_items in ((800, 20), (320, 12), (120, 8), (48, 4)):
        compact = _prompt_bounded(envelope, max_string, max_items)
        included = len(dict(compact.get(root_key) or {}))
        compact["_soduwork"] = {
            "truncated": True,
            "reason": "prompt_budget",
            "included": included,
            "omitted": max(0, len(original) - included),
        }
        visible = json.dumps(compact, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"))
        if len(visible) <= limit:
            return visible, True
    fallback = {
        root_key: {},
        "_soduwork": {"truncated": True, "reason": "prompt_budget",
                  "included": 0, "omitted": len(original)},
    }
    return json.dumps(fallback, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")), True


def _declared_artifact(source: dict, spec: dict) -> dict | None:
    receipt = dict(source.get("outputReceipt") or {})
    wanted = str(spec.get("outputKey") or "")
    declared = next((dict(item) for item in receipt.get("declared") or []
                     if str(dict(item).get("key") or "") == wanted), None)
    if not declared or not declared.get("ok"):
        return None
    kind = str(declared.get("kind") or "")
    value = {
        "available": True,
        "sourceNode": str(spec.get("fromNode") or ""),
        "outputKey": wanted,
        "kind": kind,
        "label": str(declared.get("label") or spec.get("label") or wanted),
        "value": declared.get("value"),
    }
    if kind in {"file", "decision"}:
        path = str(declared.get("value") or declared.get("path") or "")
        value["attachments"] = [
            _bounded(item) for item in source.get("attachments") or []
            if str(dict(item).get("filename") or dict(item).get("id") or "")
            .replace("\\", "/").lstrip("/") == path
        ]
        if kind == "decision" and source.get("decision"):
            value["content"] = _bounded(source.get("decision"))
    elif kind == "git":
        value["content"] = _bounded(source.get("gitDelivery") or {
            "branch": source.get("gitBranch"), "commit": source.get("gitHead")})
    elif kind == "url":
        value["content"] = str(source.get("artifactUrl") or declared.get("value") or "")
    elif kind == "evidence":
        value["content"] = _bounded({
            "text": str(receipt.get("text") or "")[:20000],
            "valid": receipt.get("valid") or [],
            "deliverables": receipt.get("deliverables") or [],
            "evidence": receipt.get("evidence") or [],
        })
    if source.get("artifactVersionId"):
        value["artifactVersionId"] = str(source.get("artifactVersionId"))
    return value


def _resolve_inputs(dependencies: dict, specs: list[dict]) -> tuple[dict, list[dict]]:
    resolved, references, missing = {}, [], []
    for raw in specs:
        spec = dict(raw or {})
        key = str(spec.get("key") or "")
        source_key = str(spec.get("fromNode") or "")
        output_key = str(spec.get("outputKey") or "")
        value = _declared_artifact(dict(dependencies.get(source_key) or {}), spec)
        reference = {"key": key, "fromNode": source_key, "outputKey": output_key,
                     "required": bool(spec.get("required", True))}
        references.append(reference)
        if value is None:
            if reference["required"]:
                missing.append(str(spec.get("label") or key or output_key))
            else:
                resolved[key] = {"available": False, **reference}
        else:
            resolved[key] = value
    if missing:
        raise workflow_contracts.WorkflowContractError(
            "节点缺少声明的上游输入：" + "、".join(missing[:8]))
    return resolved, references


def dependency_handoff(node_input: dict | None, input_specs: list[dict] | None = None,
                       max_chars: int = _MAX_PROMPT) -> dict:
    """Turn dependency evidence into a bounded, typed and auditable handoff."""
    dependencies = dict((node_input or {}).get("dependencies") or {})
    specs = [dict(item) for item in (input_specs or []) if isinstance(item, dict)]
    if not dependencies and not specs:
        return {"prompt": "", "resolvedInputs": {}, "snapshot": {
            "mode": "none", "dependencyKeys": [], "inputKeys": [], "references": [],
            "chars": 0, "checksum": "", "truncated": False}}
    if specs:
        payload, references = _resolve_inputs(dependencies, specs)
        envelope = {"inputs": payload}
        mode = "declared"
    else:
        payload = {str(key)[:100]: _bounded(value)
                   for key, value in list(dependencies.items())[:_MAX_ITEMS]}
        references = []
        envelope = {"dependencies": payload}
        mode = "legacy"
    raw = json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    limit = max(1000, min(int(max_chars or _MAX_PROMPT), _MAX_PROMPT))
    visible, truncated = _visible_json(envelope, limit)
    prompt = (
        "[UPSTREAM NODE HANDOFF]\n"
        "This is the formal, versioned input selected from completed upstream nodes. "
        "Use only these references as workflow facts; files and Git commits remain "
        "the authoritative evidence.\n" + visible
    )
    return {"prompt": prompt, "resolvedInputs": payload if specs else {},
            "snapshot": {
                "mode": mode, "dependencyKeys": list(dependencies),
                "inputKeys": list(payload) if specs else [],
                "references": references, "chars": len(visible),
                "checksum": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
                "truncated": truncated}}


def public_handoff(node_input: dict | None) -> dict:
    """Return the auditable handoff envelope without upstream payloads or secrets."""
    data = dict(node_input or {})
    snapshot = dict(data.get("contextSnapshot") or {})
    resolved = dict(data.get("resolvedInputs") or {})
    safe_inputs = {}
    for key, raw in list(resolved.items())[:_MAX_ITEMS]:
        item = dict(raw or {}) if isinstance(raw, dict) else {}
        safe_inputs[str(key)[:160]] = {
            "available": bool(item.get("available", True)),
            "sourceNode": str(item.get("sourceNode") or "")[:160],
            "outputKey": str(item.get("outputKey") or "")[:160],
            "kind": str(item.get("kind") or "")[:40],
            "label": str(item.get("label") or key)[:160],
            "artifactVersionId": str(item.get("artifactVersionId") or "")[:160],
            "attachmentCount": min(99, len(item.get("attachments") or [])),
        }
    references = []
    for raw in list(snapshot.get("references") or [])[:_MAX_ITEMS]:
        item = dict(raw or {}) if isinstance(raw, dict) else {}
        references.append({
            "key": str(item.get("key") or "")[:160],
            "fromNode": str(item.get("fromNode") or "")[:160],
            "outputKey": str(item.get("outputKey") or "")[:160],
            "required": bool(item.get("required", True)),
        })
    return {
        "resolvedInputs": safe_inputs,
        "contextSnapshot": {
            "mode": str(snapshot.get("mode") or "none")[:20],
            "dependencyKeys": [str(x)[:160] for x in
                               list(snapshot.get("dependencyKeys") or [])[:_MAX_ITEMS]],
            "inputKeys": [str(x)[:160] for x in
                          list(snapshot.get("inputKeys") or [])[:_MAX_ITEMS]],
            "references": references,
            "chars": max(0, int(snapshot.get("chars") or 0)),
            "checksum": str(snapshot.get("checksum") or "")[:64],
            "truncated": bool(snapshot.get("truncated")),
        },
    }
