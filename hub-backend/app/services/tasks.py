"""Task CRUD, bulk operations, completed-task cleanup, and handoffs, with live notifications to
affected clients.
"""
import logging
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("uvicorn.error")
_NL = chr(10)          # Newline separator for multiline prompt lists.

from .. import models
from ..realtime import hub
from ..schemas import task_to_api
from .task_parse_contract import _PARSE_SYSTEM, _apply_scene, _extract_json, _sanitize_parsed
from .task_parse_sources import _flow_choices, _parse_with_my_model

# Map client camelCase fields to model attributes.
_FIELD_MAP = {
    "assigneeUserId": "assignee_user_id",
    "domainId": "domain_id",
    "projectId": "project_id",
    "workScenarioKey": "work_scenario_key",
    "workScenarioName": "work_scenario_name",
    "workRouting": "work_routing",
    "repoId": "repo_id",
    "requesterUserId": "requester_user_id",
    "requesterName": "requester_name",
    "requesterContact": "requester_contact",
}

# Only requirement-definition fields increment requirement_version.
# The version protects content edits rather than counting all task writes.
# Execution progress and orchestration must not invalidate content checks.
# This avoids false stale-requirement conflicts during review submission.
_REQ_CONTENT_KEYS = {"title", "note", "description", "acceptanceCriteria",
                     "kind", "priority", "tags", "deps"}


def stamp_progress(new_list, old_list, uid, uname):
    """Stamp new progress entries with author identity. Preserve existing authors and match older
    entries by timestamp so handoffs do not attribute previous contributors' work to the current
    owner.
    """
    olds = {p.get("at"): p for p in (old_list or []) if isinstance(p, dict)}
    out = []
    for p in (new_list or []):
        if not isinstance(p, dict):
            continue
        p = dict(p)
        old = olds.get(p.get("at"))
        if old and old.get("by"):
            p["by"], p["byName"] = old["by"], old.get("byName", "")
        elif not p.get("by") and uid:
            p["by"], p["byName"] = uid, uname or ""
        out.append(p)
    return out


# Task-information normalization helpers.

def ms_to_dt(ms):
    """Convert milliseconds to an aware datetime, returning None for missing or invalid values."""
    if ms is None:
        return None
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return None


def normalize_output_contract(t: "models.Task") -> bool:
    """Normalize repository-change contracts to local-file delivery when no real project or
    repository exists. Such tasks cannot enter code review, merge, and deployment workflows;
    return whether normalization changed the contract.
    """
    routing = dict(t.work_routing or {})
    contract = dict(routing.get("outputContract") or {})
    if contract.get("kind") != "repository-change":
        return False
    if getattr(t, "project_id", None) or str(getattr(t, "repo_id", "") or "").strip():
        return False
    routing["outputContract"] = {
        "kind": "office-artifact",
        "summary": "未关联代码工程，按本地文件交付验收（原仓库变更合同已自动降级）。",
        "deliverables": list(contract.get("deliverables") or []),
        "acceptance": list(contract.get("acceptance") or []),
        "normalizedFrom": "repository-change",
    }
    t.work_routing = routing
    return True


def apply_detail(t: "models.Task", data: dict) -> None:
    """Apply only supplied camelCase detail fields such as priority, due date, tags, assignee, and
    recurrence to the task.
    """
    if data.get("priority"):
        t.priority = data["priority"]
    if "start" in data:
        t.start_at = ms_to_dt(data.get("start"))
    if "due" in data:
        t.due_at = ms_to_dt(data.get("due"))
    if "actualStart" in data:
        t.actual_start_at = ms_to_dt(data.get("actualStart"))
    if "actualEnd" in data:
        t.actual_end_at = ms_to_dt(data.get("actualEnd"))
    if data.get("tags") is not None:
        t.tags = list(data.get("tags") or [])
    if data.get("assigneeUserId") is not None:
        t.assignee_user_id = data.get("assigneeUserId") or None
    if "recur" in data:
        t.recur = data.get("recur") or None
    if "recurAt" in data:
        t.recur_at = ms_to_dt(data.get("recurAt"))
    if "remindAt" in data:
        t.remind_at = ms_to_dt(data.get("remindAt"))
        t.reminded = False   # Rearm the reminder when its scheduled time changes.
    if "reminded" in data and data.get("reminded") is not None:
        t.reminded = bool(data.get("reminded"))
    if data.get("domainId") is not None:
        t.domain_id = data.get("domainId") or ""
    if data.get("projectId") is not None:
        t.project_id = data.get("projectId") or None
    if data.get("repoId") is not None:
        t.repo_id = data.get("repoId") or ""
    if data.get("workScenarioKey") is not None:
        t.work_scenario_key = data.get("workScenarioKey") or ""
    if data.get("workScenarioName") is not None:
        t.work_scenario_name = data.get("workScenarioName") or ""
    if data.get("workRouting") is not None:
        t.work_routing = dict(data.get("workRouting") or {})
    if data.get("deps") is not None:
        t.deps = list(data.get("deps") or [])
    if data.get("requesterUserId") is not None:
        t.requester_user_id = data.get("requesterUserId") or None
    if data.get("requesterName") is not None:
        t.requester_name = data.get("requesterName") or ""
    if data.get("requesterContact") is not None:
        t.requester_contact = data.get("requesterContact") or ""


def stamp_actual(t: "models.Task", prev_status: str | None, new_status: str | None) -> None:
    """Stamp actual start on the first transition into progress and actual finish on completion,
    filling a missing start too. Change only empty timestamps and preserve manual values.
    """
    if not new_status or new_status == prev_status:
        return
    now = datetime.now(timezone.utc)
    if new_status == "doing" and t.actual_start_at is None:
        t.actual_start_at = now
    elif new_status == "done":
        if t.actual_start_at is None:
            t.actual_start_at = t.start_at or now
        if t.actual_end_at is None:
            t.actual_end_at = now


def default_requester(t: "models.Task", creator_uid, creator_name) -> None:
    """For delegated tasks without an explicit requester, default to the creator so completion
    receipts reach the delegator. Personal tasks do not create self-notifications.
    """
    if t.requester_user_id or t.requester_contact or t.requester_name:
        return  # Preserve an explicitly selected internal or external requester.
    if creator_uid and creator_uid != t.assignee_user_id:
        t.requester_user_id = creator_uid
        t.requester_name = creator_name or ""


async def resolve_user(session: AsyncSession, uid: str | None):
    """Resolve a user ID and display-name snapshot, retaining the ID with an empty name when
    missing.
    """
    if not uid:
        return None, ""
    u = await session.get(models.User, uid)
    if u:
        return u.id, (u.display_name or u.username)
    return uid, ""


async def owner_user(session: AsyncSession, owner_id: str):
    """Resolve the client's owner ID and display name, or None and empty when unbound."""
    c = await session.get(models.Client, owner_id)
    if c and c.user_ref:
        return await resolve_user(session, c.user_ref)
    return None, ""


async def ai_states(session: AsyncSession, task_ids: list[str]) -> dict:
    """Batch-resolve AI task state from dispatch identity, the matching latest execution session,
    and artifact receipts. Sessions determine whether execution still runs; preserve historical
    multica.* compatibility.
    """
    if not task_ids:
        return {}
    from .. import automation_models as am
    from . import ai_exec, execution_sessions
    rows = (await session.execute(
        select(models.TaskEvent)
        .where(models.TaskEvent.task_id.in_(task_ids),
               models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE))
        .order_by(models.TaskEvent.at, models.TaskEvent.id)
    )).scalars().all()
    out: dict = {}
    refs: dict[str, str] = {}
    for e in rows:
        detail = e.detail or {}
        if e.kind == ai_exec.EV_DISPATCH_STARTED:
            refs.pop(e.task_id, None)
            out[e.task_id] = {"state": "dispatching",
                              "name": detail.get("assigneeName") or detail.get("assigneeCli") or "AI"}
        elif e.kind == ai_exec.EV_DISPATCH_UNCERTAIN:
            refs.pop(e.task_id, None)
            out[e.task_id] = {
                "state": "dispatching",
                "name": detail.get("assigneeName") or detail.get("assigneeCli") or "AI",
                "confirmationPending": True,
                "phase": detail.get("phase") or "confirmation",
                "phaseName": detail.get("phaseName") or "",
                "error": detail.get("summary") or detail.get("error") or "",
                "attentionRaised": bool(detail.get("attentionRaised")),
                "nextAction": detail.get("nextAction") or "",
                "runnerOnline": detail.get("runnerOnline"),
            }
        elif e.kind == ai_exec.EV_DISPATCH_FAILED:
            refs.pop(e.task_id, None)
            out[e.task_id] = {"state": "failed",
                              "name": detail.get("assigneeName") or detail.get("assigneeCli") or "AI",
                              "error": detail.get("error") or "安排执行失败",
                              "phase": detail.get("phase") or "",
                              "phaseName": detail.get("phaseName") or ""}
        elif e.kind in ai_exec.KINDS_DISPATCHED:
            ref = str(detail.get("ref") or detail.get("issueId") or "")
            if ref:
                refs[e.task_id] = ref
            out[e.task_id] = {"state": "running",
                              "name": detail.get("assigneeName") or "AI"}
        elif e.task_id in out:
            out[e.task_id]["state"] = "done"
    if refs:
        session_rows = list((await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref.in_(set(refs.values()))))).scalars().all())
        by_ref = {row.ref: row for row in session_rows}
        for task_id, ref in refs.items():
            row = by_ref.get(ref)
            if row is None or task_id not in out:
                continue
            state = execution_sessions.canonical_state(row.state, "running")
            out[task_id]["executionState"] = state
            if state == "done":
                out[task_id]["state"] = "done"
            elif state in {"failed", "stopped", "interrupted", "cancelled", "canceled"}:
                meta = dict(row.metadata_ or {})
                out[task_id]["state"] = "failed"
                out[task_id]["error"] = str(meta.get("error") or "AI 执行未完成")[:300]
    return out


async def task_to_api_live(session: AsyncSession, task) -> dict:
    """Technical contract for task to api live."""
    api = task_to_api(task)
    ai = await ai_states(session, [task.id])
    if task.id in ai:
        api["ai"] = ai[task.id]
    from . import task_requirement_projection
    await task_requirement_projection.decorate_many(session, [task], [api])
    return api


async def list_tasks(session: AsyncSession, owner_id: str,
                     *, include_related: bool = False) -> list[dict]:
    """Executors retrieve their owned tasks; employee clients also read tasks they participate in.
    Automation-generated tasks remain available through run history and detail endpoints rather
    than the ordinary requirement pool.
    """
    client = await session.get(models.Client, owner_id)
    # Scheduled runs have their own run ledger.  Keep their Task identity for
    # execution/artifacts, but never mix those generated rows into the normal
    # requirement collection consumed by the desktop client.
    # ``source`` catches rows written by older scheduler builds before the
    # explicit origin marker existed; new rows use both fields.
    automation = or_(models.Task.origin == "automation",
                     models.Task.source == "定时派活")
    from . import task_access
    condition = and_(task_access.owner_clause(client), ~automation)
    if include_related and client is not None:
        from . import task_access
        from . import task_requirements
        condition = await task_requirements.visible_clause(session, client)
        condition = condition & ~automation
    res = await session.execute(
        select(models.Task)
        .where(condition)
        .order_by(models.Task.created_at.desc())
    )
    rows = list(res.scalars().all())
    out = [task_to_api(t) for t in rows]

    ai = await ai_states(session, [t["id"] for t in out])
    for t in out:
        if t["id"] in ai:
            t["ai"] = ai[t["id"]]
    from . import task_requirement_projection
    await task_requirement_projection.decorate_many(session, rows, out)
    if include_related and client is not None:
        from . import task_access
        out = await task_access.decorate_many(session, rows, out, client)
        from . import task_requirements
        out = await task_requirements.decorate_many(session, client, rows, out)
    return out


async def get_task(session: AsyncSession, owner_id: str, tid: str,
                   *, include_related: bool = False) -> dict | None:
    from . import task_access
    t = await session.get(models.Task, tid)
    if t is None:
        return None
    client = await session.get(models.Client, owner_id)
    if include_related and client is not None:
        from . import task_access
        from . import task_requirements
        if not await task_requirements.can_read(session, client, t):
            return None
    elif not task_access.is_owner(t, client):
        return None
    # Single-task reads and deep links share the list and WebSocket AI-state contract.
    # Dispatch and failure state must appear without waiting for a full list refresh.
    api = await task_to_api_live(session, t)
    if include_related and client is not None:
        from . import task_access
        decorated = (await task_access.decorate_many(session, [t], [api], client))[0]
        return await task_requirements.decorate(session, client, t, decorated)
    return api



# Parse a natural-language task request into title, time, assignee, and priority to prefill the form.
# The user confirms or edits the result. Return {} on missing model configuration, failure, or invalid output so manual entry remains available.


async def parse_task_text(session: AsyncSession, text: str, client=None, model: str = "", *, automation=None, instruction=None, attachments=None) -> dict:
    """Infer task fields plus explainable professional context and a recommended workflow from
    natural language.
    """
    from datetime import datetime
    from . import work_catalog, automation_draft, task_parse_selection, task_parse_materials

    text = (text or "").strip()
    # Attachments supplement model context; catalog matching and explicit choices still use the original task instruction.
    model_input = task_parse_materials.user_input(text, attachments)
    if not text:
        return {}
    now = datetime.now()
    org_id, positions = None, []
    if client is not None and getattr(client, "user_ref", None):
        user = await session.get(models.User, client.user_ref)
        if user:
            org_id, positions = user.org_id, list(user.positions or [])
    catalog = await work_catalog.catalog_for_user(
        session, org_id, positions, text=text)
    scenes = list(catalog.get("scenarios") or [])
    recommendation = dict(catalog.get("recommendation") or {})
    flows = await _flow_choices(session, client, limit=None)
    draft = await automation_draft.prepare(session, client, automation)
    repos = ([row["name"] for row in draft["candidates"]["repos"]]
             if draft is not None else await _repo_choices(session, client))
    system = _PARSE_SYSTEM.format(
        today=now.strftime("%Y-%m-%d"),
        weekday="一二三四五六日"[now.weekday()],
        scenes=_NL.join(
            "    · %s ＝ %s（%s）" % (
                row["key"], row["name"], row.get("description") or "")
            for row in scenes) or "    （暂无工作场景）",
        flows=_NL.join(
            "    · %s ＝ %s（%s）" % (
                row["key"], row["name"], row["desc"])
            for row in flows[:20])
        or "    （这台 SoduWork 上没有可用的流程，flow 一律填空字符串）",
        repos=_NL.join("    · %s" % row for row in repos)
        or "    （没有登记工程，repo 一律省略）",
    )
    system += automation_draft.prompt(draft)
    out = ""
    if client is not None:
        out = await _parse_with_my_model(
            session, client, model, system, model_input)
    if not out:
        from . import llm
        out = await llm.chat(
            session, system, model_input, temperature=0.2) or ""
    if not out:
        got = _apply_scene({}, scenes, recommendation, flows)
        got = task_parse_selection.apply(got, text if instruction is None else instruction, flows)
        got["_repos"] = repos
        if draft is not None:
            got["automationBindings"] = {}
        return got
    parsed = _extract_json(out)
    got = _apply_scene(
        _sanitize_parsed(parsed),
        scenes, recommendation, flows)
    got = task_parse_selection.apply(got, text if instruction is None else instruction, flows)
    if draft is not None:
        got["automationBindings"] = automation_draft.bindings(parsed, draft)
    got["_repos"] = repos
    return got


async def _repo_choices(session: AsyncSession, client) -> list[str]:
    """List repository names this user may select, for both model suggestions and confirmation
    forms.
    """
    try:
        from . import task_execution_options
        if client is None or not getattr(client, "id", None):
            return []
        _, rows = await task_execution_options._visible_repos(session, client)
        return [str(row["name"]) for row in rows if row.get("name")][:20]
    except Exception as e:  # noqa: BLE001
        log.warning("取工程清单失败：%s", type(e).__name__)
        return []


async def create_task(
    session: AsyncSession, owner_id: str, data: dict, origin: str = "local",
    notify: bool = True, creator: tuple | None = None, task_id: str | None = None,
    commit: bool = True, arrival: str = "", by: str = "",
) -> dict:
    from . import task_status, work_catalog

    data = await work_catalog.enrich_task_data(session, owner_id, data)
    status = str(data.get("status") or "todo")
    if status not in task_status.VALID:
        raise HTTPException(status_code=400, detail="需求状态不正确")
    identity = {"id": task_id} if task_id else {}
    t = models.Task(
        **identity,
        owner_client_id=owner_id,
        title=data.get("title") or "未命名",
        source=data.get("source") or "",
        note=data.get("note") or "",
        status=status,
        urgent=data.get("urgent"),
        important=data.get("important"),
        handler=data.get("handler") or "me",
        result=data.get("result") or "",
        origin=origin,
        external_id=data.get("externalId"),
        external_url=data.get("externalUrl"),
    )
    from . import task_requirements
    data = dict(data)
    actor = await session.get(models.Client, owner_id)
    if creator and creator[0] and actor:
        actor = SimpleNamespace(id=actor.id, user_ref=creator[0])
    await task_requirements.apply(session, actor, t, data, creating=True)
    apply_detail(t, data)
    normalize_output_contract(t)
    # Prefer an explicit creator; default local tasks to the client's owner.
    cid, cname = creator if creator else (None, "")
    if not cid and origin == "local":
        cid, cname = await owner_user(session, owner_id)
    t.created_by, t.created_by_name = cid, cname
    # Default an unspecified assignee to the client's owner.
    if t.assignee_user_id is None:
        au, _ = await owner_user(session, owner_id)
        t.assignee_user_id = au
    t.progress = stamp_progress(data.get("progress"), None, cid, cname)
    stamp_actual(t, None, t.status)
    default_requester(t, cid, cname)   # Use the creator as requester for delegated-task completion receipts.
    session.add(t)
    # Record who dispatched externally assigned tasks; avoid redundant creation events for personal tasks.
    if origin != "local":
        from . import task_events
        await session.flush()          # Obtain the task ID first.
        task_events.record(session, t.id, "created", {"source": t.source, "origin": origin}, cname)
    assignment_notice = None
    if origin == "dispatch":
        from . import task_assignment_notifications
        assignment_notice = await task_assignment_notifications.create(session, t, cid)
    if notify and commit:
        from . import task_notifications
        await session.flush()
        event_arrival, event_by = str(arrival or "").strip(), str(by or "").strip()
        if (not event_arrival and origin == "dispatch" and cid and
                t.assignee_user_id and str(cid) != str(t.assignee_user_id)):
            event_arrival, event_by = "dispatch", cname
        task_notifications.enqueue(session, t, "task.created", arrival=event_arrival,
            by=event_by, assignee=t.assignee_user_id,
            notification_id=assignment_notice.id if assignment_notice else "")
    if commit:
        await session.commit()
    else:
        await session.flush()
    await session.refresh(t)
    api = task_to_api(t)
    return api


async def put_local_task(session: AsyncSession, owner_id: str, tid: str, data: dict) -> dict | None:
    """Idempotently create or update a local task using the client-generated ID. Reject tasks owned by another device or originating from aggregation or assignment so offline PUT operations cannot take ownership or overwrite external data."""
    from . import task_access
    client = await session.get(models.Client, owner_id)
    current = await session.get(models.Task, tid)
    if current is not None:
        if not task_access.is_owner(current, client) or current.origin != "local":
            return None
        return await update_task(session, owner_id, tid, data)
    try:
        return await create_task(session, owner_id, data, origin="local", task_id=tid)
    except IntegrityError:  # Another window may have inserted the same task during concurrent replay.
        await session.rollback()
        current = await session.get(models.Task, tid)
        # Treat only a confirmed existing identical ID as replay or ID collision.
        # Preserve unrelated database constraint errors.
        # Do not misreport migration failures as occupied task identifiers.
        if current is None:
            raise
        if not task_access.is_owner(current, client) or current.origin != "local":
            return None
        return await update_task(session, owner_id, tid, data)


async def update_task(session: AsyncSession, owner_id: str, tid: str, patch: dict) -> dict | None:
    from . import task_access
    await task_access.reserve_task_write(session, tid, owner_id)
    client = await session.get(models.Client, owner_id)
    t = (await session.execute(select(models.Task).where(
        models.Task.id == tid, task_access.owner_clause(client)
    ).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    client = await session.get(models.Client, owner_id)
    if t is None:
        candidate = (await session.execute(select(models.Task).where(models.Task.id == tid)
                     .with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
        from . import task_requirements
        if candidate is None or client is None or not await task_requirements.can_read(session, client, candidate):
            return None
        return await task_requirements.update_shared(session, client, candidate, dict(patch or {}))
    prev_status = t.status
    patch = dict(patch or {})
    from . import task_requirements
    if patch.get("status") == "cancel" and t.status != "cancel":
        from . import task_maintenance
        await task_maintenance.ensure_allowed(session, [t], action="archive", client=client)
    previous_org = t.shared_org_id
    prev_assignee = t.assignee_user_id
    requirement_edit = "requirementVersion" in patch
    edit_facts = await task_requirements.apply(session, client, t, patch)
    if requirement_edit and t.requirement_content:
        content = dict(t.requirement_content)
        for key in {"title", "note"}.intersection(patch):
            content[key] = patch.pop(key)
        t.requirement_content = content
    has_status, requested_status = "status" in patch, patch.pop("status", None)
    has_progress, requested_progress = "progress" in patch, patch.pop("progress", None)
    from . import task_status
    if has_status:
        requested_status = str(requested_status or "")
        if requested_status not in task_status.VALID:
            raise HTTPException(status_code=400, detail="需求状态不正确")
        if t.origin in {"gitlab_issue", "github_issue"} and requested_status == "doing" and prev_status != "doing":
            # Claiming an Issue only assigns its preparation owner. Human starts
            # must pass the same readiness gate as execution dispatch.
            try:
                task_requirements.ensure_executable(t)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
    if "workScenarioKey" in patch:
        from . import work_catalog
        routed = await work_catalog.enrich_task_data(session, owner_id, {
            "title": patch.get("title", t.title), "note": patch.get("note", t.note),
            "tags": patch.get("tags", t.tags), "projectId": patch.get("projectId", t.project_id),
            "workScenarioKey": patch.get("workScenarioKey") or "",
            "workRouting": patch.get("workRouting", t.work_routing),
        })
        for field in ("workScenarioKey", "workScenarioName", "workRouting"):
            if field in routed:
                patch[field] = routed[field]
    else:
        patch.pop("workScenarioName", None)
        patch.pop("workRouting", None)
    for k, v in patch.items():
        if k == "start":
            t.start_at = ms_to_dt(v)
        elif k == "due":
            t.due_at = ms_to_dt(v)
        elif k == "actualStart":
            t.actual_start_at = ms_to_dt(v)
        elif k == "actualEnd":
            t.actual_end_at = ms_to_dt(v)
        elif k == "recurAt":
            t.recur_at = ms_to_dt(v)
        elif k == "remindAt":
            t.remind_at = ms_to_dt(v); t.reminded = False
        elif k == "tags":
            t.tags = list(v or [])
        elif k == "deps":
            t.deps = list(v or [])
        else:
            setattr(t, _FIELD_MAP.get(k, k), v)
    transition, applied = None, True
    if has_status:
        applied = await task_status.mark(
            session, t, requested_status, why="客户端需求更新", refresh_memory=False)
        if not applied:
            transition = await task_status.rejection(session, t, requested_status)
            transition.update({"requested": requested_status, "actual": t.status, "applied": False})
        elif requested_status == "doing" and prev_status != "doing":
            # This is the owner's explicit human take-ownership action. Runner
            # dispatch and queue admission do not pass through this CRUD path.
            from . import repository_issue_access
            await repository_issue_access.record_started(session, t)
    if has_progress and (not has_status or applied):
        uid_, uname_ = await owner_user(session, owner_id)
        t.progress = stamp_progress(requested_progress, t.progress, uid_, uname_)
    became_done = bool(has_status and applied and prev_status != "done" and t.status == "done")
    normalize_output_contract(t)
    # Content-version claims already increment requirement_version in task_requirements.apply.
    # Do not increment it again for the same edit.
    # Execution-only updates to state, progress, or orchestration do not change that version.
    if not requirement_edit and set(patch) & _REQ_CONTENT_KEYS:
        t.requirement_version = int(t.requirement_version or 1) + 1
    event_arrival, event_by, assignment_notice = "", "", None
    if t.assignee_user_id and t.assignee_user_id != prev_assignee:
        owner_uid, actor_name = await owner_user(session, owner_id)
        if str(t.assignee_user_id) != str(owner_uid or ""):
            from . import task_assignment_notifications
            event_arrival, event_by = "assign", actor_name
            assignment_notice = await task_assignment_notifications.transition(
                session, t, owner_uid, "assign",
                {"fromUserId": prev_assignee, "toUserId": t.assignee_user_id}, actor_name)
    from . import task_notifications
    task_notifications.enqueue(session, t, "task.updated", arrival=event_arrival,
        by=event_by, assignee=t.assignee_user_id, previous_org=previous_org,
        notification_id=assignment_notice.id if assignment_notice else "",
        closed=became_done, closer=owner_id)
    await session.commit()
    await session.refresh(t)
    api = task_to_api(t)
    api["projectionPending"] = True
    if transition:
        api["statusTransition"] = transition
    from . import task_access
    decorated = task_access.decorate(t, api, client, {}, {})
    decorated.pop("assigneeName", None)
    decorated.pop("executionDeviceName", None)
    return await task_requirements.decorate(session, client, t, decorated)


async def purge_task_children(
    session: AsyncSession, tids: list[str]
) -> tuple[dict, list[tuple[str, str]]]:
    """Hard-delete the complete task aggregate and return object-storage keys.

    Task execution tables deliberately have no database foreign keys because runners and
    workflow workers write them independently.  A hard-deleted task therefore has to be
    removed as one aggregate here; retaining detached sessions or approvals would pollute
    usage, approval and delivery statistics without preserving a meaningful audit subject.
    Enterprise retention must use a future soft-delete/archive policy, not orphan rows.

    Physical objects are returned to the caller and deleted *after* the SQL transaction
    commits.  A failed database commit must never leave a live attachment row pointing at a
    file that was already removed.
    """
    if not tids:
        return {}, []
    from sqlalchemy import delete as _del, update as _update
    from .. import automation_models as am

    task_ids = list(dict.fromkeys(str(item) for item in tids if item))
    attachments = list((await session.execute(
        select(models.Attachment).where(models.Attachment.task_id.in_(task_ids))
    )).scalars().all())
    storage_refs = [(row.storage_key, row.backend) for row in attachments if row.storage_key]
    run_ids = list((await session.execute(
        select(am.WorkflowRun.id).where(am.WorkflowRun.task_id.in_(task_ids))
    )).scalars().all())
    request_ids = list((await session.execute(
        select(am.ApprovalRequest.id).where(am.ApprovalRequest.task_id.in_(task_ids))
    )).scalars().all())
    session_ids = list((await session.execute(
        select(am.ExecutionSession.id).where(am.ExecutionSession.task_id.in_(task_ids))
    )).scalars().all())

    out: dict[str, int] = {}

    # Keep the external Issue identity as a tombstone: polling must not recreate
    # a requirement the user deliberately deleted. Stop unsent start writeback.
    from sqlalchemy import case
    from ..repository_issue_models import RepositoryIssueLink
    await session.execute(_update(RepositoryIssueLink).where(
        RepositoryIssueLink.task_id.in_(task_ids)).values(task_id=None,
            writeback_state=case((RepositoryIssueLink.writeback_state.in_(("pending", "error")), "manual"),
                                else_=RepositoryIssueLink.writeback_state),
            next_retry_at=None, last_error="需求已删除，Issue 后续状态请人工核对"))

    async def remove(name, model, condition) -> None:
        result = await session.execute(_del(model).where(condition))
        out[name] = int(result.rowcount or 0)

    # Delete leaves before their aggregate roots.  The schema intentionally does not enforce
    # these links with foreign keys, but preserving dependency order keeps the contract safe if
    # constraints are added later.
    if request_ids:
        await remove("approval_assignment", am.ApprovalAssignment,
                     am.ApprovalAssignment.request_id.in_(request_ids))
        await remove("approval_decision", am.ApprovalDecision,
                     am.ApprovalDecision.request_id.in_(request_ids))
    if session_ids:
        await remove("execution_event", am.ExecutionEvent,
                     am.ExecutionEvent.session_id.in_(session_ids))
    if run_ids:
        await remove("workflow_outbox", am.WorkflowOutbox,
                     am.WorkflowOutbox.run_id.in_(run_ids))
        await remove("workflow_event", am.WorkflowEvent,
                     am.WorkflowEvent.run_id.in_(run_ids))
        await remove("node_run", am.NodeRun, am.NodeRun.run_id.in_(run_ids))

    for name, model in (
        ("requirement_access", models.TaskRequirementAccess),
        ("comment", models.TaskComment),
        ("event", models.TaskEvent),
        ("milestone", models.Milestone),
        ("attachment", models.Attachment),
        ("evolution", am.EvolutionProposal),
        ("evaluation", am.TaskEvaluation),
        ("approval", am.ApprovalRequest),
        ("deployment", am.DeploymentRun),
        ("artifact", am.ArtifactVersion),
        ("execution_session", am.ExecutionSession),
        ("workflow_run", am.WorkflowRun),
    ):
        await remove(name, model, model.task_id.in_(task_ids))

    # Other aggregates may keep a non-owning pointer to the deleted task.  Clear those pointers
    # instead of deleting the schedule or batch milestone that owns them.
    await session.execute(_update(models.Milestone).where(
        models.Milestone.src_task_id.in_(task_ids)).values(src_task_id=""))
    await session.execute(_update(models.AiSchedule).where(
        models.AiSchedule.last_task_id.in_(task_ids)).values(last_task_id=""))
    return out, storage_refs


def _delete_task_storage(refs: list[tuple[str, str]]) -> None:
    from . import storage
    for key, backend in refs:
        storage.delete(key, backend)


async def delete_task(session: AsyncSession, owner_id: str, tid: str) -> dict:
    from . import task_access, task_requirements, task_maintenance
    t = await session.get(models.Task, tid, with_for_update=True, populate_existing=True)
    client = await session.get(models.Client, owner_id)
    if t is None or client is None or not await task_requirements.can_read(session, client, t):
        return {"ok": False, "reason": "not_found"}
    if not await task_requirements.can_maintain(session, client, t):
        raise HTTPException(403, "你只能查看这条需求，不能删除")
    await task_maintenance.ensure_allowed(session, [t], action="delete", client=client)
    recipients = await task_access.recipient_clients(session, t)
    _, storage_refs = await purge_task_children(session, [tid])
    previous_org = t.shared_org_id
    await session.delete(t)
    from . import task_notifications
    task_notifications.enqueue(session, t, "task.deleted", recipients=[c.id for c in recipients],
        recipient_accounts={c.id: c.user_ref or "" for c in recipients}, previous_org=previous_org)
    await session.commit()
    _delete_task_storage(storage_refs)
    return {"ok": True}


async def clear_done(session: AsyncSession, owner_id: str) -> dict:
    """Clear completed tasks only; preserve cancelled tasks."""
    from . import task_access
    client = await session.get(models.Client, owner_id)
    res = await session.execute(
        select(models.Task).where(
            task_access.owner_clause(client), models.Task.status == "done"
        ).order_by(models.Task.id).with_for_update().execution_options(populate_existing=True)
    )
    rows = res.scalars().all()
    from . import task_maintenance
    await task_maintenance.ensure_allowed(session, rows, action="delete", client=client)
    ids = [t.id for t in rows]
    from . import task_access
    recipients = {t.id: await task_access.recipient_clients(session, t) for t in rows}
    _, storage_refs = await purge_task_children(session, ids)
    for t in rows:
        await session.delete(t)
        from . import task_notifications
        viewers = recipients.get(t.id, [])
        task_notifications.enqueue(session, t, "task.deleted", recipients=[c.id for c in viewers],
            recipient_accounts={c.id: c.user_ref or "" for c in viewers})
    await session.commit()
    _delete_task_storage(storage_refs)
    return {"removed": len(ids)}


async def batch_update(session: AsyncSession, owner_id: str, ids: list[str], patch: dict) -> dict:
    count = rejected = 0
    for tid in ids:
        result = await update_task(session, owner_id, tid, patch)
        if result is not None:
            count += 1
            rejected += int(bool(result.get("statusTransition")))
    return {"updated": count, "statusRejected": rejected}
