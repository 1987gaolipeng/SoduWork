"""AI output ingestion: download, validate, classify, freeze versions, and request review. ai_exec
retains executor routing responsibility.
"""
from __future__ import annotations

import os
import hashlib

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from . import ai_exec as _exec

log = _exec.log
KINDS_ARTIFACTS = _exec.KINDS_ARTIFACTS
EV_ARTIFACTS = _exec.EV_ARTIFACTS
REMOTE_PREFIX = _exec.REMOTE_PREFIX
_ai_local = _exec._ai_local
_p = _exec._p
_cfg_of = _exec._cfg_of
_by_ref_async = _exec._by_ref_async
last_dispatch_event = _exec.last_dispatch_event
provider_name = _exec.provider_name
runner_info_sync = _exec.runner_info_sync


async def pull_artifacts(session: AsyncSession, tid: str, ctx: dict, s: dict, ref: str = "",
                         settle: bool = True) -> dict:
    """Idempotently import AI files and URLs into the task, record ai.artifacts, and notify the
    creator for review. Adapters only provide artifact bytes.
    """
    import asyncio as _aio
    from datetime import datetime, timezone

    from ..models import Attachment, Task, TaskEvent
    from . import delivery_manifest, storage, task_events
    t = await session.get(Task, tid)
    if t is None:
        return {"files": 0, "url": ""}
    # Record the provider actually associated with the execution ref.
    # Global provider configuration may differ from the executor that produced the artifact.
    # Prefer provider and runnerId recorded in the dispatch event for authoritative, network-free routing.
    # Use asynchronous discovery only for legacy records without those fields.
    # Synchronous RPC here would block the event loop while waiting for itself.
    _route_ev = await last_dispatch_event(session, tid) if ref else None
    _route = (_route_ev.detail or {}) if _route_ev is not None else {}
    _route_name = str(_route.get("provider") or "")
    if _route_name == "runner":
        from . import ai_remote as _remote
        _remote.remember(ref, str(_route.get("runnerId") or ""))
        _ref_provider = _remote
    elif _route_name == "local":
        _ref_provider = _ai_local
    elif _route_name:
        _ref_provider = _p(ctx)
    else:
        _ref_provider = await _by_ref_async(ref) if ref else None
    actual_provider = ("local" if _ref_provider is _ai_local else
                       "runner" if getattr(_ref_provider, "PREFIX", "") == REMOTE_PREFIX else
                       provider_name(ctx))
    who = "agent:" + actual_provider
    # Bind artifacts to the exact persisted execution provenance.
    # For legacy executions, recover the plugin snapshot from ai.dispatched rather than guessing by time window.
    _source_session = None
    if ref:
        _source_session = (await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == ref).limit(1))).scalar_one_or_none()
    _plugin_source = dict(_route.get("plugin") or {})
    _source_run = str(getattr(_source_session, "workflow_run_id", "") or
                      _plugin_source.get("runId") or "")
    _source_node = str(getattr(_source_session, "node_run_id", "") or
                       _plugin_source.get("nodeId") or "")
    _atts = s.get("attachments") or []
    marker = str(s.get("identifier") or "")
    try:
        round_no = max(0, int(s.get("round") or 0))
    except (TypeError, ValueError):
        round_no = 0
    received: set[str] = set()
    valid: set[str] = set()
    deliverables: set[str] = set()
    evidence: set[str] = set()
    ignored: set[str] = set()
    invalid: list[dict] = []
    known_urls: set[str] = set()
    receipts = (await session.execute(select(TaskEvent).where(
        TaskEvent.task_id == tid, TaskEvent.kind.in_(KINDS_ARTIFACTS)
    ))).scalars().all()
    for event in receipts:
        detail = dict(event.detail or {})
        same_source = ((ref and detail.get("ref") == ref)
                       or (marker and detail.get("identifier") == marker))
        if not same_source:
            continue
        try:
            old_round = max(0, int(detail.get("round") or 0))
        except (TypeError, ValueError):
            old_round = 0
        # Legacy receipts without a round belong to the initial round only.
        if round_no and old_round != round_no and not (round_no == 1 and old_round == 0):
            continue
        received.update(delivery_manifest.normalize_name(x)
                        for x in (detail.get("files") or []) if x)
        valid.update(delivery_manifest.normalize_name(x)
                     for x in (detail.get("valid") or []) if x)
        deliverables.update(delivery_manifest.normalize_name(x)
                            for x in (detail.get("deliverables") or []) if x)
        evidence.update(delivery_manifest.normalize_name(x)
                        for x in (detail.get("evidence") or []) if x)
        ignored.update(delivery_manifest.normalize_name(x)
                       for x in (detail.get("ignored") or []) if x)
        invalid.extend(dict(x) for x in (detail.get("invalid") or []) if isinstance(x, dict))
        if detail.get("artifactUrl"):
            known_urls.add(str(detail["artifactUrl"]).strip())
    got: list[str] = []
    # For local execution, prefer reading the original workspace file.
    # Process-specific transparent encryption can make another uploader read encrypted bytes.
    # The authorized backend process may read the plaintext from the same path.
    # Use downloaded bytes only when the local file is unavailable.
    wd = ""
    if actual_provider == "local":
        try:
            ri = await _aio.to_thread(runner_info_sync, ctx, ref) if ref else {}
            wd = (ri or {}).get("workDirAbs") or ""
        except Exception:  # noqa: BLE001
            wd = ""
        if not wd:
            wd = (s or {}).get("workDirAbs") or ""
    # A remote Runner path belongs to that machine. A coincidentally matching
    # Hub path must never substitute unrelated local bytes for cloud output.
    # Avoid a second independent ten-file limit when transferring collected artifacts.

    # Keep this transfer cap aligned with ai_local._ART_CAP so neither stage silently truncates outputs.
    _ATT_CAP = 200
    if len(_atts) > _ATT_CAP:
        log.warning("产出 %d 个，超过上限只搬 %d 个（任务 %s）", len(_atts), _ATT_CAP, tid)
    for a in _atts[:_ATT_CAP]:
        fn = delivery_manifest.normalize_name(a.get("filename") or "")
        if not fn or fn in received:
            continue                                  # Deduplicate within one execution only; rework outputs with the same name create a new version.
        data = None
        local = ""
        if wd:
            root = os.path.realpath(wd)
            candidate = os.path.realpath(os.path.join(root, *fn.split("/")))
            try:
                if os.path.commonpath([root, candidate]) == root:
                    local = candidate
            except ValueError:
                local = ""
        if local and os.path.isfile(local):
            try:
                with open(local, "rb") as fh:
                    data = fh.read()
                log.info("产出取本地原文（绕开透明加密）: %s", fn)
            except Exception:  # noqa: BLE001
                data = None
        if data is None:
            _fp = _ref_provider or _p(ctx)
            # Use execution-scoped artifact retrieval whenever a ref is available.
            # Relative paths such as index.html can repeat across concurrent tasks.
            if ref and hasattr(_fp, "fetch_attachment_for_sync"):
                data = await _aio.to_thread(
                    _fp.fetch_attachment_for_sync, _cfg_of(ctx, _fp), ref, a["id"])
            else:
                data = await _aio.to_thread(_fp.fetch_attachment_sync, _cfg_of(ctx, _fp), a["id"])
        if data is None:
            continue
        import mimetypes
        import uuid as _uuid
        ctype = mimetypes.guess_type(fn)[0] or "application/octet-stream"
        verification = delivery_manifest.validate_bytes(fn, data, ctype)
        category = delivery_manifest.classify_name(fn, role="output")
        if verification.get("state") != "passed":
            # Keep damaged deliverables and supporting files visible as failed delivery items.
            # Reclassifying them as process evidence would hide incomplete output packages.
            role = ("output" if category in ("primary", "supporting") else
                    "verification" if category == "evidence" else "process")
            invalid.append({"name": fn, "reason": verification.get("reason") or "文件校验失败"})
        elif category == "evidence":
            role = "verification"
            evidence.add(fn)
            valid.add(fn)
        elif category in ("primary", "supporting"):
            role = "output"
            deliverables.add(fn)
            valid.add(fn)
        else:
            role = "process"
            ignored.add(fn)
            valid.add(fn)  # Explicit file contracts may accept types that generic evidence classification does not.
        key = f"ai/{tid}/{_uuid.uuid4().hex[:8]}-{fn}"
        backend = storage.put(key, data, ctype)
        session.add(Attachment(task_id=tid, filename=fn, content_type=ctype, size=len(data),
                               storage_key=key, backend=backend, uploaded_by=who,
                               role=role, source_ref=ref,
                               workflow_run_id=_source_run, node_run_id=_source_node,
                               evidence_meta={"provider": actual_provider,
                                              "sha256": hashlib.sha256(data).hexdigest(),
                                              "identifier": marker,
                                              **({"round": round_no} if round_no else {}),
                                              "category": category,
                                              "verification": verification},
                               created_at=datetime.now(timezone.utc)))
        got.append(fn)
        received.add(fn)
    url = (s.get("artifactUrl") or "").strip()
    new_url = bool(url) and url != (getattr(t, "artifact_url", "") or "")
    new_url_receipt = bool(url) and url not in known_urls
    if new_url:
        t.artifact_url = url
    missing = sorted({delivery_manifest.normalize_name(a.get("filename") or "") for a in _atts
                      if a.get("filename")} - received)
    _dropped = int(s.get("artifactsDropped") or 0) + max(0, len(_atts) - _ATT_CAP)
    if got or new_url or new_url_receipt:
        # Record excluded artifact counts in the timeline so incomplete delivery remains visible.

        task_events.record(session, tid, EV_ARTIFACTS,
                           {"files": got, "artifactUrl": url, "identifier": marker, "ref": ref,
                            "provider": actual_provider,
                            **({"round": round_no} if round_no else {}),
                            "valid": sorted(valid), "deliverables": sorted(deliverables),
                            "evidence": sorted(evidence), "ignored": sorted(ignored),
                            "invalid": invalid[-100:],
                            **({"dropped": _dropped,
                                "droppedNote": "产出太多，只收了 %d 个，还有 %d 个没收进来"
                                               "（都在执行机的工作目录里）" % (len(got), _dropped)}
                               if _dropped else {})}, actor=who)
        await session.commit()
        # The plugin engine needs file receipts only; later declared nodes own versions, review requests, and task completion.
        # Do not invoke the ordinary-dispatch completion path from an intermediate plugin node.
        # That could create approvals before the declared quality gates.
        if not settle:
            return {"files": len(got), "url": url, "received": sorted(received),
                    "valid": sorted(valid), "deliverables": sorted(deliverables),
                    "evidence": sorted(evidence), "ignored": sorted(ignored),
                    "invalid": invalid[-100:],
                    "missing": missing}




        code = {}
        try:
            from . import code_delivery
            code = await code_delivery.check(session, t, who="SoduWork", force=True)
        except Exception as e:  # noqa: BLE001 - Delivery-check failures must not prevent artifact ingestion.
            log.warning("代码交付判定失败: %s", type(e).__name__)
        if not code.get("applies"):
            # Freeze file and URL candidates before review.
            # Content changes alter the checksum and invalidate earlier approvals.
            candidate_ready = False
            missing_outputs = [name for name in missing
                               if delivery_manifest.is_deliverable_name(name)]
            if not _dropped and not invalid and not missing_outputs:
                try:
                    from . import release_control as _release
                    await _release.ensure_current_output(session, t, source_ref=ref, who="SoduWork")
                    await session.commit()
                    candidate_ready = True
                except ValueError:
                    pass
            # Execution completion does not complete the task; human approval and the shared completion gate remain required.
            if candidate_ready:
                from . import code_delivery as _cd
                await _cd.notify_reviewer(session, t, url or ("、".join(got) if got else "产出"))
    if settle and s.get("done") and not missing and not invalid and not _dropped:
        from . import cloud_deliveries
        await cloud_deliveries.archive_if_cloud(session, tid)
    return {"files": len(got), "url": url, "received": sorted(received),
            "valid": sorted(valid), "deliverables": sorted(deliverables),
            "evidence": sorted(evidence), "ignored": sorted(ignored),
            "invalid": invalid[-100:],
            "missing": missing}
