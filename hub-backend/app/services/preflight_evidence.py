"""Fingerprint-bound, sanitized evidence for read-only capability probes."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am


_SECRET = re.compile(r"password|passwd|token|secret|private.?key|api.?key", re.I)


def fingerprint(payload: dict) -> str:
    raw = json.dumps(payload or {}, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _safe(value, depth: int = 0):
    """Keep useful probe facts while making accidental credential persistence difficult."""
    if depth > 5:
        return "…"
    if isinstance(value, dict):
        return {str(key)[:80]: _safe(child, depth + 1)
                for key, child in list(value.items())[:80]
                if not _SECRET.search(str(key))}
    if isinstance(value, list):
        return [_safe(item, depth + 1) for item in value[:100]]
    if isinstance(value, str):
        return value[:1200]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:1200]


async def get(session: AsyncSession, subject_kind: str, subject_id: str,
              check_kind: str) -> am.PreflightEvidence | None:
    return (await session.execute(select(am.PreflightEvidence).where(
        am.PreflightEvidence.subject_kind == subject_kind,
        am.PreflightEvidence.subject_id == subject_id,
        am.PreflightEvidence.check_kind == check_kind,
    ).limit(1))).scalar_one_or_none()


async def get_many(session: AsyncSession, subject_kind: str,
                   subject_ids: set[str], check_kind: str) -> dict[str, am.PreflightEvidence]:
    if not subject_ids:
        return {}
    rows = list((await session.execute(select(am.PreflightEvidence).where(
        am.PreflightEvidence.subject_kind == subject_kind,
        am.PreflightEvidence.subject_id.in_(subject_ids),
        am.PreflightEvidence.check_kind == check_kind,
    ))).scalars().all())
    return {row.subject_id: row for row in rows}


async def record(session: AsyncSession, *, subject_kind: str, subject_id: str,
                 check_kind: str, config_fingerprint: str, ok: bool,
                 summary: str = "", executor_id: str = "", executor_name: str = "",
                 detail: dict | None = None) -> am.PreflightEvidence:
    row = await get(session, subject_kind, subject_id, check_kind)
    if row is None:
        row = am.PreflightEvidence(
            subject_kind=subject_kind, subject_id=subject_id, check_kind=check_kind)
        session.add(row)
    row.fingerprint = str(config_fingerprint or "")[:64]
    row.state = "passed" if ok else "failed"
    row.summary = str(summary or "")[:600]
    row.executor_id = str(executor_id or "")[:80]
    row.executor_name = str(executor_name or "")[:100]
    row.detail = _safe(dict(detail or {}))
    row.checked_at = datetime.now(timezone.utc)
    await session.flush()
    return row


def api(row: am.PreflightEvidence | None, current_fingerprint: str) -> dict:
    if row is None:
        return {"state": "never", "ok": False, "stale": False,
                "summary": "尚未做真实预检", "checkedAt": None,
                "executorId": "", "executorName": "", "detail": {}}
    stale = bool(current_fingerprint and row.fingerprint != current_fingerprint)
    state = "stale" if stale else row.state
    dt = row.checked_at
    if dt is not None and dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return {
        "state": state, "ok": row.state == "passed" and not stale, "stale": stale,
        "summary": "配置已变化，需要重新预检" if stale else row.summary,
        "checkedAt": int(dt.timestamp() * 1000) if dt else None,
        "executorId": row.executor_id, "executorName": row.executor_name,
        "detail": dict(row.detail or {}),
    }


CONTRACT_SOURCE_RUNTIME = "contract-source-runtime"
_PREFLIGHT_EVIDENCE_MODES = {CONTRACT_SOURCE_RUNTIME}


def normalize_mode(value, node_key: str = "") -> str:
    """Validate one opt-in read-only workflow evidence mode."""
    mode = str(value or "").strip()
    if not mode:
        return ""
    if mode not in _PREFLIGHT_EVIDENCE_MODES:
        label = f" for node {node_key}" if node_key else ""
        raise ValueError(f"unsupported preflight evidence mode{label}: {mode}")
    return mode


def prompt(value) -> str:
    """Guide a clean preflight without weakening downstream quality gates."""
    mode = normalize_mode(value)
    if not mode:
        return ""
    return (
        "[SODUWORK READ-ONLY PREFLIGHT EVIDENCE POLICY]\n"
        "This node runs in a clean, read-only clone. Prefer an existing failing test or "
        "a live API reproduction. Missing installed project dependencies or downstream "
        "credentials alone is not a blocker when SoduWork managed delivery preflight is READY. "
        "You may conclude that a defect is reproducible without executing the application only "
        "when all of these facts are present: (1) an exact externally observable contract, "
        "(2) the exact source file and code path that violates it, and (3) deterministic language "
        "or runtime semantics that make the violation unambiguous. Record all three facts as "
        "evidence in workflow-decision.json. Also confirm that the repository contains a lockfile "
        "and an authoritative quality command that can install locked dependencies and run the "
        "real suite later. The implementation node must add a regression test that fails before "
        "the fix and passes after it; the authoritative quality gate remains mandatory. Do not "
        "modify source, tests, dependencies or Git state in this preflight node. If any proof is "
        "ambiguous, return blocked instead of guessing."
    )
