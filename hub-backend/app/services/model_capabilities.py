"""Declared capabilities and credential-scoped, revision-bound probe evidence."""
from __future__ import annotations

import json

from . import context_window
from .runtime_defaults import DEFAULT_OUTPUT

# Both Hub and Runner import this module.
# Defer Hub-only SQLAlchemy, AppSetting, fingerprint, and lock_setting imports until use.
# Top-level database dependencies would enter the standalone Runner import chain.
# Preserve the requirements-runner dependency boundary.
# Packaged Runners do not include SQLAlchemy.
# A database import failure would make available local executors disappear.

CAPABILITIES = ("imageInput", "toolCalling", "streaming")
STATES = ("unknown", "supported", "unsupported")
MIN_OUTPUT, MAX_OUTPUT = 1024, 262144


def validate_limits(context, config: dict) -> int:
    if context in (None, ""):
        context = 0
    try:
        value = int(context)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("上下文窗口必须是 0–10000000 的整数") from exc
    if isinstance(context, bool) or str(value) != str(context) or not 0 <= value <= 10000000:
        raise ValueError("上下文窗口必须是 0–10000000 的整数")
    if value and config.get("maxOutputTokens", 0) > value:
        raise ValueError("最大输出不能超过上下文窗口")
    return value


def clean_config(raw: dict) -> dict:
    out = {}
    if "capabilities" in raw:
        values = raw["capabilities"]
        if not isinstance(values, dict) or any(key not in CAPABILITIES for key in values):
            raise ValueError("模型能力配置无效")
        if any(value not in STATES for value in values.values()):
            raise ValueError("模型能力必须是支持、不支持或未确认")
        out["capabilities"] = dict(values)
    if "maxOutputTokens" in raw and raw["maxOutputTokens"] is not None:
        value = raw["maxOutputTokens"]
        if isinstance(value, bool) or not isinstance(value, int) or not MIN_OUTPUT <= value <= MAX_OUTPUT:
            raise ValueError("最大输出量必须是 1024–262144 的整数")
        out["maxOutputTokens"] = value
    if (raw.get("imageRouting") == "native"
            and (out.get("capabilities") or {}).get("imageInput") == "unsupported"):
        raise ValueError("不支持图片输入的模型不能选择原生识图")
    return out


def profile(config: dict, evidence: dict | None = None) -> dict:
    configured = config.get("capabilities") or {}
    checks = (evidence or {}).get("checks") or {}
    result = {}
    for key in CAPABILITIES:
        state = configured.get(key, "unknown")
        source = "configured" if state != "unknown" else "unknown"
        checked = checks.get(key) or {}
        if state == "unknown" and key == "imageInput" and config.get("imageRouting") == "native":
            state, source = "supported", "legacy-native"
        if state == "unknown" and checked.get("status") in ("passed", "unsupported"):
            state = "supported" if checked["status"] == "passed" else "unsupported"
            source = "verified"
        result[key] = {"state": state, "source": source}
        if checked.get("checkedAt"):
            result[key]["checkedAt"] = checked["checkedAt"]
            result[key]["checkStatus"] = checked.get("status", "inconclusive")
    reported = bool((evidence or {}).get("reasoningStreamReported"))
    result["reasoningStream"] = {"state": "reported" if reported else "unknown",
                                  "source": "verified" if reported else "unknown"}
    return result


def runtime_fields(config: dict, evidence: dict | None = None) -> dict:
    capabilities = profile(config, evidence)
    # Infer only unspecified/automatic routes; an explicit adapter selection
    # may encode gateway limits even when the model itself supports images.
    route = config.get("imageRouting")
    if route not in ("native", "vision-fallback"):
        route = "native" if capabilities["imageInput"]["state"] == "supported" else "vision-fallback"
    return {"capabilityProfile": capabilities, "imageRouting": route,
            "maxOutputTokens": config.get("maxOutputTokens") or DEFAULT_OUTPUT}


def identity(row: dict, provider: dict, key: str, scope: str) -> tuple[str, str]:
    from .model_runtime import fingerprint
    slot = "model-check-v1:" + fingerprint([scope, provider["id"], row["name"]])[:40]
    revision = fingerprint({"version": 1, "scope": scope, "provider": provider["id"],
                            "base": provider.get("baseUrl"), "kind": provider.get("kind"),
                            "key": key, "authMode": provider.get("authMode"),
                            "model": row["name"], "config": row.get("config") or {},
                            "contextWindow": context_window.resolve({
                                "contextWindow": row.get("ctxWindow") or row.get("contextWindow"),
                                "modelName": row["name"], "providerId": provider["id"],
                            })["contextWindow"]})
    return slot, revision


async def enrich(session, rows: list[dict], providers: dict, client=None) -> list[dict]:
    from .model_catalog import provider_key
    targets = {}
    for index, row in enumerate(rows):
        if row.get("modality", "chat") != "chat":
            continue
        provider = providers.get(row["providerId"])
        if provider:
            key, key_from = provider_key(provider, client)
            targets[index] = identity(row, provider, key, principal_scope(client, row, key_from))
    stored = {}
    if targets:
        from sqlalchemy import select
        from ..models import AppSetting
        records = (await session.execute(select(AppSetting).where(
            AppSetting.key.in_([slot for slot, _ in targets.values()])))).scalars().all()
        for record in records:
            try:
                stored[record.key] = json.loads(record.value)
            except (ValueError, TypeError):
                pass
    for index, row in enumerate(rows):
        if row.get("modality", "chat") != "chat":
            continue
        slot, revision = targets.get(index, ("", ""))
        evidence = stored.get(slot)
        if not isinstance(evidence, dict) or evidence.get("configRevision") != revision:
            evidence = None
        row.update(runtime_fields(row.get("config") or {}, evidence))
        row["capabilityCheck"] = evidence
        row["configRevision"] = revision
        row["runtimeRevision"] = runtime_revision(revision, row)
    return rows


def principal_scope(client=None, row=None, key_from="") -> str:
    # Organization checks apply to the same saved organization model using the
    # same organization credential. Personal model aliases and keys stay private.
    if client is None or (key_from == "org" and not (row or {}).get("own")):
        return "organization"
    return ("client:" + str(client.id) + ":" + str(getattr(client, "user_ref", "") or "")
            if client is not None else "organization")


def runtime_revision(config_revision: str, fields: dict) -> str:
    from .model_runtime import fingerprint
    return fingerprint({"config": config_revision, "capabilities": fields.get("capabilityProfile"),
                        "imageRouting": fields.get("imageRouting"), "maxOutputTokens": fields.get("maxOutputTokens")})


async def persist(session, slot: str, result: dict) -> dict:
    from .model_runtime import lock_setting
    row = await lock_setting(session, slot)
    try:
        previous = json.loads(row.value)
    except (ValueError, TypeError):
        previous = {}
    if previous.get("configRevision") == result["configRevision"]:
        result = {**result, "checks": {**previous.get("checks", {}), **result["checks"]},
                  "reasoningStreamReported": bool(previous.get("reasoningStreamReported")
                                                   or result.get("reasoningStreamReported"))}
    row.value = json.dumps(result)
    await session.commit()
    return result
