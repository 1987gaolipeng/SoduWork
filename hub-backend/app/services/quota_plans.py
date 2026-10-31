"""Versioned quota policies and account grants; the usage ledger owns counters.

    AppSetting already provides indexed, transactional key/value persistence.
    Plans are a bounded catalog; grants are separate per-account records. No
    parallel billing counters or database startup schema changes are introduced.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator
from sqlalchemy import select

from ..models import AppSetting
from . import quota_usage
from .model_catalog import canonical_model_name

CATALOG_KEY = "quota_plans_v1"
GRANT_PREFIX = "quota_grant:"
MAX_TOKENS = 10_000_000_000_000


class ModelAllowance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(min_length=1, max_length=60)
    model: str = Field(min_length=1, max_length=160)
    limit: StrictInt = Field(ge=0, le=MAX_TOKENS)

    @field_validator("provider", "model")
    @classmethod
    def clean_identity(cls, value, info):
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("A model and provider are required")
        return canonical_model_name(value) if info.field_name == "model" else value


class Allowance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    totalLimit: StrictInt | None = Field(default=None, ge=0, le=MAX_TOKENS)
    models: list[ModelAllowance] = Field(default_factory=list, max_length=100)
    restrictModels: bool = False

    @model_validator(mode="after")
    def distinct_models(self):
        keys = [(row.provider, row.model) for row in self.models]
        if len(keys) != len(set(keys)):
            raise ValueError("A model may appear only once in a plan")
        if self.restrictModels and not self.models:
            raise ValueError("Choose at least one permitted model")
        return self


class Plan(Allowance):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,47}$")
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(default="", max_length=300)
    period: str = Field(default="monthly", pattern=r"^(monthly|once)$")
    durationDays: StrictInt = Field(default=7, ge=1, le=365)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        if not value.strip():
            raise ValueError("A plan name is required")
        return value.strip()

    @model_validator(mode="after")
    def finite_trial(self):
        if self.period == "once" and (self.id != "trial" or not self.totalLimit):
            raise ValueError("The one-time trial must have a positive total allowance")
        if self.id == "trial" and self.period != "once":
            raise ValueError("The registration trial cannot renew monthly")
        return self


class Catalog(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: StrictInt = Field(default=0, ge=0)
    plans: list[Plan] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def valid_plans(self):
        ids = [plan.id for plan in self.plans]
        if len(ids) != len(set(ids)) or "trial" not in ids:
            raise ValueError("Plan IDs must be unique and the registration trial is required")
        return self


DEFAULT_CATALOG = Catalog(plans=[
    Plan(id="trial", name="试用", period="once", durationDays=7, totalLimit=100_000),
    Plan(id="standard", name="标准", totalLimit=1_000_000),
    Plan(id="pro", name="专业", totalLimit=5_000_000),
]).model_dump()


def parse(value):
    if not value:
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("Invalid quota record")
    return parsed


def catalog_from(value):
    return Catalog.model_validate(parse(value) or DEFAULT_CATALOG).model_dump()


async def catalog(session):
    value = await session.scalar(select(AppSetting.value).where(AppSetting.key == CATALOG_KEY))
    return catalog_from(value)


async def register_trial(session, user_id, *, now=None):
    """Join verified registration's transaction. Never grant on login or refresh."""
    key = GRANT_PREFIX + user_id
    if await session.scalar(select(AppSetting.key).where(AppSetting.key == key)):
        return
    trial = next(p for p in (await catalog(session))["plans"] if p["id"] == "trial")
    start = now or datetime.now(timezone.utc)
    grant = {"revision": 1, "mode": "plan", "planId": "trial", "trial": {
        "policy": trial, "startedAt": start.isoformat(),
        "expiresAt": (start + timedelta(days=trial["durationDays"])).isoformat(),
    }}
    session.add(AppSetting(key=key, value=json.dumps(grant, ensure_ascii=False)))


def effective(grant, plans):
    """Trial terms are frozen; ordinary plan edits apply on the next admission."""
    if not grant or grant.get("mode") == "inherit":
        return None
    if grant.get("mode") == "custom":
        return {**Allowance.model_validate(grant["custom"]).model_dump(),
                "id": "custom", "name": "个人配置", "period": "monthly"}
    if grant.get("planId") == "trial":
        return Plan.model_validate(grant["trial"]["policy"]).model_dump()
    return next((p for p in plans["plans"] if p["id"] == grant.get("planId")), None)


def status_from(policy, grant, usage, *, now=None, provider="", model=""):
    now = now or datetime.now(timezone.utc)
    _, end = quota_usage.month_window(now)
    trial = policy.get("period") == "once"
    expires = grant.get("trial", {}).get("expiresAt") if trial else None
    expired = bool(expires and now >= datetime.fromisoformat(expires))
    limit = policy.get("totalLimit")
    used = sum(usage.values())
    total_exceeded = limit is not None and used >= limit
    model_rows = []
    # Older native Pi receipts use the synthetic "soduwork" gateway namespace,
    # which is not an upstream provider identity. Count unknown attribution
    # against matching model caps conservatively without rewriting the ledger.
    for row in policy.get("models", []):
        count = sum(value for (p, m), value in usage.items()
                    if (p in ("", "soduwork") or p == row["provider"]) and (not m or m == row["model"]))
        unattributed = sum(value for (p, m), value in usage.items()
                           if (p in ("", "soduwork") or not m)
                           and (p in ("", "soduwork") or p == row["provider"])
                           and (not m or m == row["model"]))
        model_rows.append({**row, "used": count, "remaining": max(0, row["limit"] - count),
                           "exceeded": count >= row["limit"], "unattributedUsed": unattributed})
    selected = next((row for row in model_rows if row["provider"] == provider
                     and row["model"] == canonical_model_name(model)), None)
    restricted = bool(policy.get("restrictModels"))
    model_denied = bool(model and restricted and selected is None)
    all_models_exhausted = restricted and all(row["exceeded"] for row in model_rows)
    reason = ("trial_expired" if expired else "total_exhausted" if total_exceeded else
              "model_not_allowed" if model_denied else
              "model_exhausted" if (selected and selected["exceeded"]) or all_models_exhausted else "")
    return {
        "enabled": limit is not None or bool(model_rows) or trial,
        "limit": limit or 0, "used": used,
        "remaining": max(0, limit - used) if limit is not None else None,
        "exceeded": bool(reason), "reason": reason,
        "period": "trial" if trial else now.astimezone(quota_usage.CHINA_TZ).strftime("%Y-%m"),
        "mode": grant.get("mode", "plan"), "planId": policy["id"], "planName": policy["name"],
        "expiresAt": expires, "resetsAt": None if trial else end.isoformat(),
        "models": model_rows, "restrictModels": restricted,
        "model": selected, "totalLimited": limit is not None,
        "requestedModel": {"provider": provider, "model": canonical_model_name(model)} if model else None,
    }


async def status(session, user_id, rows, *, now=None, provider="", model=""):
    grant = parse(rows.get(GRANT_PREFIX + str(user_id or "")))
    if not grant or grant.get("mode") == "inherit":
        return None
    # Ordinary business requests never read or parse the plan catalog. Trials
    # and custom grants already carry their policy; only named plans need it.
    plans = await catalog(session) if grant.get("mode") == "plan" and grant.get("planId") != "trial" else {"plans": []}
    policy = effective(grant, plans)
    if policy is None:
        # A referenced plan must not disappear and turn a limited account unlimited.
        raise ValueError("The assigned quota plan no longer exists")
    usage = await quota_usage.totals(session, [user_id], monthly=policy["period"] != "once", now=now)
    return status_from(policy, grant, usage.get(user_id, {}), now=now, provider=provider, model=model)
