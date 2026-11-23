"""Declared capabilities and credential-scoped, revision-bound probe evidence."""
from __future__ import annotations

import json
import secrets

from . import context_window
from .model_capability_wire import compatibility
from .runtime_defaults import DEFAULT_OUTPUT

# Both Hub and Runner import this module.
# Defer Hub-only SQLAlchemy, AppSetting, fingerprint, and lock_setting imports until use.
# Top-level database dependencies would enter the standalone Runner import chain.
# Preserve the requirements-runner dependency boundary.
# Packaged Runners do not include SQLAlchemy.
# A database import failure would make available local executors disappear.

CAPABILITIES = ("imageInput", "toolCalling", "streaming")
CHECKS = ("connection", *CAPABILITIES)
API_FAMILY = "chat-completions"
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


def _conclusive(check) -> bool:
    return isinstance(check, dict) and check.get("status") in ("passed", "unsupported")


def _mapping(value) -> dict:
    return value if isinstance(value, dict) else {}


def project_evidence(raw) -> dict:
    evidence = _mapping(raw)
    if evidence.get("reportVersion") == 3:
        return evidence
    checks = dict(_mapping(evidence.get("checks")))
    verified = dict(_mapping(evidence.get("verifiedChecks")))
    changed = False
    # v2 never tested streaming tool-result continuation. Retire its tool
    # success only; retain independent checks and explicit feature refusals.
    version_two = evidence.get("reportVersion") == 2
    for key in (("toolCalling",) if version_two else ("toolCalling", "streaming")):
        latest, prior = _mapping(checks.get(key)), _mapping(verified.get(key))
        if _conclusive(latest) and (not version_two or latest["status"] == "passed"):
            checks[key] = {**latest, "status": "inconclusive", "code": "legacy_recheck_required"}
            changed = True
        if _conclusive(prior) and (not version_two or prior["status"] == "passed"):
            verified.pop(key, None)
            if not latest:
                checks[key] = {**prior, "status": "inconclusive", "code": "legacy_recheck_required"}
            changed = True
    if not changed:
        return evidence
    result = {**evidence, "checks": checks}
    if "verifiedChecks" in evidence:
        result["verifiedChecks"] = verified
    return result


def evidence_checks(evidence=None) -> dict:
    evidence = project_evidence(evidence)
    if not isinstance(evidence, dict) or evidence.get("apiFamily", API_FAMILY) != API_FAMILY:
        return {}
    values = _mapping(evidence.get("verifiedChecks", evidence.get("checks")))
    return {key: check for key, check in values.items() if key in CHECKS and _conclusive(check)}


def merge_evidence(previous, result: dict) -> dict:
    previous, result = project_evidence(previous), project_evidence(result)
    same = (previous.get("configRevision") == result.get("configRevision")
            and previous.get("apiFamily", API_FAMILY) == result.get("apiFamily", API_FAMILY))
    if same and previous.get("runSequence", 0) > result.get("runSequence", 0):
        return public_evidence(previous)
    checks = dict(_mapping(previous.get("checks"))) if same else {}
    verified = dict(evidence_checks(previous)) if same else {}
    image_rejected_since_pass = same and previous.get("imageInputRejectedSincePass") is True
    for key, check in _mapping(result.get("checks")).items():
        if key not in CHECKS or not isinstance(check, dict):
            continue
        older = _mapping(checks.get(key))
        # A sequence orders concurrent runs. Dates protect imported v1 evidence.
        if (not result.get("runSequence") and older.get("checkedAt") and check.get("checkedAt")
                and older["checkedAt"] > check["checkedAt"]):
            continue
        checks[key] = dict(check)
        if not _conclusive(check):
            continue
        if key == "imageInput":
            # Chat retains proven support; manual conflicts follow the latest conclusive attempt.
            image_rejected_since_pass = bool(result.get("configRevision") and check["status"] == "unsupported"
                                             and _mapping(verified.get(key)).get("status") == "passed")
            if image_rejected_since_pass:
                continue
        verified[key] = dict(check)
    return {**public_evidence(result), "reportVersion": 3,
            "apiFamily": result.get("apiFamily", API_FAMILY), "checks": checks, "verifiedChecks": verified,
            "imageInputRejectedSincePass": image_rejected_since_pass,
            "compatibility": {**(compatibility(previous.get("compatibility")) if same else {}),
                              **compatibility(result.get("compatibility"))},
            "reasoningStreamReported": bool(result.get("reasoningStreamReported")
                                             or same and previous.get("reasoningStreamReported"))}


def public_evidence(value: dict) -> dict:
    return {key: item for key, item in project_evidence(value).items() if not key.startswith("_")}


def profile(config: dict, evidence: dict | None = None) -> dict:
    evidence = project_evidence(evidence)
    configured = _mapping(config.get("capabilities"))
    checks = _mapping((evidence or {}).get("checks"))
    known = evidence_checks(evidence)
    result = {}
    for key in CAPABILITIES:
        state = configured.get(key, "unknown")
        if state not in STATES:
            state = "unknown"
        source = "configured" if state != "unknown" else "unknown"
        checked, verified = _mapping(checks.get(key)), known.get(key) or {}
        if state == "unknown" and key == "imageInput" and config.get("imageRouting") == "native":
            state, source = "supported", "legacy-native"
        if state == "unknown" and _conclusive(verified):
            state = "supported" if verified["status"] == "passed" else "unsupported"
            source = "verified"
        result[key] = {"state": state, "source": source}
        if checked.get("checkedAt"):
            result[key]["checkedAt"] = checked["checkedAt"]
            result[key]["checkStatus"] = checked.get("status", "inconclusive")
        if _conclusive(verified):
            verified_state = "supported" if verified["status"] == "passed" else "unsupported"
            result[key]["verifiedState"] = verified_state
            if verified.get("checkedAt"):
                result[key]["lastVerifiedAt"] = verified["checkedAt"]
            observed_state = ("unsupported" if key == "imageInput" and evidence.get("imageInputRejectedSincePass") is True
                              else verified_state)
            if source != "verified" and state != "unknown" and observed_state != state:
                result[key]["conflict"] = True
    reported = bool((evidence or {}).get("apiFamily", API_FAMILY) == API_FAMILY
                    and (evidence or {}).get("reasoningStreamReported"))
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
            "input": ["text", "image"] if route == "native" and capabilities["imageInput"]["state"] == "supported" else ["text"],
            "maxOutputTokens": config.get("maxOutputTokens") or DEFAULT_OUTPUT,
            "compatibility": compatibility((evidence or {}).get("compatibility")
                if (evidence or {}).get("apiFamily", API_FAMILY) == API_FAMILY else {})}


def identity(row: dict, provider: dict, key: str, scope: str, *, generations=None, legacy=False) -> tuple[str, str]:
    from .model_runtime import fingerprint
    from .model_capability_generations import request_config
    slot = "model-check-v1:" + fingerprint([scope, provider["id"], row["name"]])[:40]
    values = {"version": 1, "scope": scope, "provider": provider["id"],
                            "base": provider.get("baseUrl"), "kind": provider.get("kind"),
                            "key": key, "authMode": provider.get("authMode"),
                            "model": row["name"], "config": (row.get("config") or {}) if legacy
                                else request_config(row.get("config")),
                            "contextWindow": context_window.resolve({
                                "contextWindow": row.get("ctxWindow") or row.get("contextWindow"),
                                "modelName": row["name"], "providerId": provider["id"],
                            })["contextWindow"]}
    if generations:
        values["savedTargetGeneration"] = generations
    revision = fingerprint(values)
    return slot, revision


async def enrich(session, rows: list[dict], providers: dict, client=None) -> list[dict]:
    from .model_catalog import provider_key
    from .model_capability_generations import target_keys
    targets = {}
    for index, row in enumerate(rows):
        if row.get("modality", "chat") != "chat":
            continue
        provider = providers.get(row["providerId"])
        if provider:
            key, key_from = provider_key(provider, client)
            scope = principal_scope(client, row, key_from)
            slot, _ = identity(row, provider, key, scope)
            targets[index] = (slot, provider, key, scope, target_keys(row, provider, client))
    stored = {}
    if targets:
        from sqlalchemy import select
        from ..models import AppSetting
        records = (await session.execute(select(AppSetting).where(
            AppSetting.key.in_({name for slot, _, _, _, generations in targets.values()
                                for name in (slot, *generations)})))).scalars().all()
        for record in records:
            try:
                stored[record.key] = json.loads(record.value)
            except (ValueError, TypeError):
                pass
    for index, row in enumerate(rows):
        if row.get("modality", "chat") != "chat":
            continue
        target = targets.get(index)
        slot, revision = "", ""
        generations = {}
        if target:
            slot, provider, key, scope, generation_keys = target
            generations = {name: stored[name] for name in generation_keys
                           if type(stored.get(name)) is int and stored[name] > 0}
            _, revision = identity(row, provider, key, scope, generations=generations)
        evidence = stored.get(slot)
        if (isinstance(evidence, dict) and evidence.get("reportVersion", 1) == 1 and not generations
                and target and evidence.get("configRevision") == identity(row, provider, key, scope, legacy=True)[1]):
            # Read v1 evidence against its exact old target fingerprint. The
            # next admitted run upgrades this record under the short slot lock.
            evidence = {**evidence, "configRevision": revision}
        if not isinstance(evidence, dict) or evidence.get("configRevision") != revision:
            evidence = None
        row.update(runtime_fields(row.get("config") or {}, evidence))
        row["capabilityCheck"] = public_evidence(evidence) if evidence and evidence.get("checks") else None
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
    return fingerprint({"config": config_revision,
                        "capabilities": {key: (fields.get("capabilityProfile") or {}).get(key, {}).get("state", "unknown")
                                         for key in CAPABILITIES},
                        "input": fields.get("input"), "compatibility": compatibility(fields.get("compatibility")),
                        "imageRouting": fields.get("imageRouting"), "maxOutputTokens": fields.get("maxOutputTokens")})


def _stored(row) -> dict:
    try:
        value = json.loads(row.value)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


async def begin_run(session, slot: str, revision: str, *, lifetime=130, legacy_revision=None) -> dict:
    from .model_runtime import lock_setting, _now
    from fastapi import HTTPException
    row = await lock_setting(session, slot)
    previous = _stored(row)
    if (previous.get("reportVersion", 1) == 1 and legacy_revision
            and previous.get("configRevision") == legacy_revision):
        previous = {**previous, "configRevision": revision}
    stamp = await _now(session)
    active = previous.get("_probeLease") or {}
    if active.get("expires", 0) > stamp and active.get("configRevision") == revision:
        await session.rollback()
        raise HTTPException(409, "A capability check for this saved model is already running")
    sequence = max(previous.get("_lastRunSequence", 0), previous.get("runSequence", 0)) + 1
    lease = {"token": secrets.token_hex(16), "sequence": sequence,
             "configRevision": revision, "expires": stamp + lifetime}
    row.value = json.dumps({**previous, "_lastRunSequence": sequence, "_probeLease": lease})
    await session.commit()
    return lease


async def release_run(session, slot: str, lease: dict):
    from .model_runtime import lock_setting
    row = await lock_setting(session, slot)
    previous = _stored(row)
    if (previous.get("_probeLease") or {}).get("token") == lease["token"]:
        previous.pop("_probeLease", None)
        row.value = json.dumps(previous)
    await session.commit()


async def persist(session, slot: str, result: dict, *, lease=None) -> dict:
    from .model_runtime import lock_setting
    row = await lock_setting(session, slot)
    previous = _stored(row)
    if lease is not None:
        from fastapi import HTTPException
        active = previous.get("_probeLease") or {}
        if (active.get("token") != lease["token"]
                or previous.get("_lastRunSequence") != lease["sequence"]):
            raise HTTPException(409, "A newer capability check has superseded this result")
        result = {**result, "runSequence": lease["sequence"]}
    result = merge_evidence(previous, result)
    internal = {key: item for key, item in previous.items() if key.startswith("_")}
    if lease is not None:
        internal.pop("_probeLease", None)
    row.value = json.dumps({**result, **internal})
    await session.commit()
    return result
