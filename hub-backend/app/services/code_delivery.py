"""Code-delivery discovery and explicitly authorized merging. Discovery and sweeps only find pushed
commits and create immutable candidates; workflow or approval commands call ship. Track none,
committed, merged, and conflict states, preserving historical events. Never merge or deploy from
status reads, and do not retry conflicts automatically.
"""
from __future__ import annotations

import asyncio
import logging
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from .task_access import publish_owner
from . import git_ops, release_control, resource_leases, scm_support, task_code_targets, task_events

log = logging.getLogger("uvicorn.error")

EV_COMMITTED = "ai.committed"
EV_MERGED = "ai.merged"        # Keep event names compatible with historical merge records.
EV_DEPLOYED = "ai.deployed"

# Status polling is frequent, while branch discovery requires git fetch.
# Throttle discovery per task and skip Git entirely once delivery is already merged.
_MIN_GAP = 90.0
_LAST: dict[str, float] = {}

# Serialize discovery, candidate creation, and merging with a per-task lock.
# Forced checks intentionally bypass throttling.
# They may overlap with background sweeps.
# Without serialization, concurrent paths could repeat Git operations and events.
# Acquire the lock and then reread state; throttling alone cannot prevent races.
_MERGE_LOCKS: dict[str, asyncio.Lock] = {}


def _merge_lock(tid: str) -> asyncio.Lock:
    lk = _MERGE_LOCKS.get(tid)
    if lk is None:
        lk = _MERGE_LOCKS[tid] = asyncio.Lock()
    return lk


# Repository selection for task delivery.
def _delivery_ready(repo: models.Repo) -> bool:
    """Check code-delivery eligibility from repository URL and target branch. Use the actual
    Runner's clean mirror; server_dir is only a same-host compatibility fallback. Historical
    Gerrit mappings require explicit migration before execution.
    """
    if str(getattr(repo, "scm", "") or "").lower() == "gerrit":
        return False
    return bool((repo.git_url or "").strip() and (repo.merge_branch or "").strip())


async def repo_for(session: AsyncSession, t) -> models.Repo | None:
    """Resolve the task's deliverable repository, or None when code-delivery rules do not apply."""
    frozen = await task_code_targets.get(session, str(t.id))
    if frozen is not None:
        live = await session.get(models.Repo, frozen.repo_id)
        view = await task_code_targets.repo_view(session, t, live)
        scm_support.require_active(view)
        return view if view is not None and _delivery_ready(view) else None
    pid = getattr(t, "project_id", None)
    if not pid:
        return None
    rows = (await session.execute(
        select(models.Repo).where(models.Repo.project_id == pid))).scalars().all()
    rid = str(getattr(t, "repo_id", "") or "").strip()
    if rid:
        chosen = next((r for r in rows if r.id == rid), None)
        scm_support.require_active(chosen)
        if chosen is not None and _delivery_ready(chosen):
            return chosen
    ready = [r for r in rows if _delivery_ready(r)]
    if not ready:
        for row in rows:
            scm_support.require_active(row)
        return None
    return ready[0]



async def _task_git_creds(session: AsyncSession, task) -> dict:
    """Resolve the task owner's write-only code account for server-side Git."""
    owner_id = str(getattr(task, "owner_client_id", None) or "")
    client = await session.get(models.Client, owner_id) if owner_id else None
    if client is None:
        return {}
    from . import code_creds
    return code_creds.resolve(client)


async def _ensure_repo(repo, task, git_creds: dict) -> dict:
    return await asyncio.to_thread(
        git_ops.ensure_server_repo, repo.server_dir, repo.git_url,
        git_creds, str(task.id))


async def _default_runner_route(session: AsyncSession, task) -> dict:
    """Select a tenant-safe SCM Runner, preferring the task owner's desktop node."""
    from . import environment_service, runner_hub
    allowed = await environment_service.task_runner_clients(session, task)
    allowed_orgs = await environment_service.task_runner_orgs(session, task)
    runner = runner_hub.pick_for(
        str(getattr(task, "owner_client_id", "") or ""), allowed_client_ids=allowed,
        required_capabilities=["repository", "terminal"],
        allowed_org_ids=allowed_orgs)
    if runner is None:
        return {}
    return {"provider": "runner", "runnerId": runner.id, "host": runner.host}


# Read persisted status without Git access.
async def read_state(session: AsyncSession, tid: str) -> dict:
    """Read delivery state from the timeline without network calls for frequent frontend polling."""
    rows = (await session.execute(
        select(models.TaskEvent)
        .where(models.TaskEvent.task_id == tid,
               models.TaskEvent.kind.in_((EV_COMMITTED, EV_MERGED)))
        .order_by(models.TaskEvent.at.desc()).limit(20))).scalars().all()
    st = {"stage": "none", "branch": "", "target": "", "commits": [], "files": [],
          "scm": {}, "containsTarget": False,
          "mergeCommit": "", "error": "", "tail": "", "conflict": False}
    merged = next((r for r in rows
                   if r.kind == EV_MERGED and (r.detail or {}).get("ok")), None)
    committed = next((r for r in rows if r.kind == EV_COMMITTED), None)
    if committed:
        d = committed.detail or {}
        st.update(stage="committed", branch=d.get("branch") or "",
                  target=d.get("target") or "", commits=d.get("commits") or [],
                  files=d.get("files") or [], scm=dict(d.get("scm") or {}),
                  containsTarget=bool(d.get("containsTarget")))
    if merged:
        d = merged.detail or {}
        st.update(stage="merged", branch=d.get("branch") or st["branch"],
                  target=d.get("target") or st["target"],
                  mergeCommit=d.get("commit") or "")
        return st
    # Expose conflicts separately; preserve other merge-failure details with committed state.
    # A failed merge applies only until a new candidate is submitted.
    # A later committed event supersedes an earlier conflict after rework.
    fail = next((r for r in rows
                 if r.kind == EV_MERGED and not (r.detail or {}).get("ok")
                 and (committed is None or r.at >= committed.at)), None)
    if fail:
        d = fail.detail or {}
        st["conflict"] = bool(d.get("conflict"))
        st["error"] = str(d.get("error") or "")[:300]
        st["tail"] = str(d.get("tail") or "")[:400]     # Raw Git output is displayed separately from explanatory text.
        if st["conflict"]:
            st["stage"] = "conflict"
    return st


async def is_delivered(session: AsyncSession, task, state: dict | None = None) -> bool:
    state = state or await read_state(session, task.id)
    if state.get("stage") != "merged":
        return False
    from . import deployments
    return await deployments.delivery_complete(session, task)


def _merged_state_matches_head(state: dict, head_hint: str = "") -> bool:
    """Keep the merged fast path only while it describes the reported execution head.

    Review rework can produce a new commit after the previous candidate was merged. A
    task-level ``ai.merged`` event must not hide that newer immutable identity.
    """
    if str(state.get("stage") or "") != "merged":
        return False
    expected = str(head_hint or "").strip().lower()
    if not expected:
        return True
    merged = str(state.get("mergeCommit") or "").strip().lower()
    return bool(merged and merged == expected)


async def managed_by_active_workflow(session: AsyncSession, task_id: str) -> bool:
    """Plugin nodes exclusively control candidate creation and approval timing during plugin
    execution.
    """
    from .. import automation_models as am
    return bool(await session.scalar(select(am.WorkflowRun.id).where(
        am.WorkflowRun.task_id == task_id,
        am.WorkflowRun.state.in_(("queued", "running", "waiting_human", "waiting_external"))
    ).limit(1)))


# Public delivery entry points.
async def check(session: AsyncSession, t, who: str = "SoduWork", force: bool = False,
                branch_hint: str = "", head_hint: str = "",
                scm_hint: dict | None = None) -> dict:
    """Discover branch commits and create candidates and review requests idempotently. Return
    persisted state plus applies, delivered, and throttled flags; never merge or publish.
    """
    state = await read_state(session, t.id)
    repo = await repo_for(session, t)
    if repo is None:
        return {**state, "applies": False, "delivered": False}
    scm_support.require_active(repo)
    state.update(applies=True, delivered=await is_delivered(session, t, state))
    if _merged_state_matches_head(state, head_hint):
        return state
    git_creds = await _task_git_creds(session, t)
    # Do not retroactively create candidates for completed legacy tasks. force permits refresh, never approval bypass.
    if t.status in ("done", "cancel") and state["stage"] == "none" and not force:
        return {**state, "reason": "这条活已经结束了，不会自动去合它的老分支（要合请人工重试）"}
    if state["conflict"] and not force:
        return state                       # Leave conflicts for explicit remediation rather than retrying them on every poll.
    now = time.monotonic()
    if not force and now - _LAST.get(t.id, 0.0) < _MIN_GAP:
        return {**state, "throttled": True}
    _LAST[t.id] = now

    # Serialize branch discovery, commit recording, and candidate creation per task.
    async with _merge_lock(t.id):
        state = await read_state(session, t.id)
        state.update(applies=True, delivered=await is_delivered(session, t, state))
        if _merged_state_matches_head(state, head_hint):
            return state                       # Return immediately if another caller has already completed the merge.
        if state["conflict"] and not force:
            return state
        known_branch = branch_hint or str(state.get("branch") or "")
        known_scm = dict(scm_hint or state.get("scm") or {})
        return await _check_locked(
            session, t, repo, state, who, known_branch, head_hint, git_creds,
            known_scm)


async def _check_locked(session: AsyncSession, t, repo, state: dict, who: str,
                        branch_hint: str = "", head_hint: str = "",
                        git_creds: dict | None = None,
                        scm_hint: dict | None = None) -> dict:
    """Perform Git discovery while holding the task lock; never merge or push."""
    br = str(branch_hint or "").strip()
    scm = dict(scm_hint or {})
    if br and scm.get("provider") != "runner" and not str(repo.server_dir or "").strip():
        scm = await _default_runner_route(session, t)
    if br:
        if scm.get("provider") == "runner":
            from . import ai_remote
            hinted = await asyncio.to_thread(ai_remote.git_inspect_sync, scm, {
                "gitUrl": repo.git_url, "branch": br, "target": repo.merge_branch,
                "git": git_creds or {}, "taskId": str(t.id)})
        else:
            ready = await _ensure_repo(repo, t, git_creds or {})
            if not ready.get("ok"):
                return {**state, "stage": "none", "branch": br,
                        "error": str(ready.get("error") or "服务端仓库未就绪")[:500]}
            hinted = await asyncio.to_thread(
                git_ops.branch_commits, repo.server_dir, br, repo.merge_branch, 20, True,
                git_creds, str(t.id))
        expected = str(head_hint or "").strip().lower()
        actual = str(hinted.get("head") or "").strip().lower()
        if expected and actual and expected != actual:
            return {**state, "stage": "none", "branch": br,
                    "error": f"执行会话提交 {expected[:12]} 与远端分支最新提交 {actual[:12]} 不一致"}
        if not hinted.get("ok") or not hinted.get("commits"):
            # Zero commits ahead may mean either no work or content already merged into the target.
            # Conflict resolution may have completed and pushed the merge before this check.
            # Do not repeatedly fail the merge gate merely because no unmerged commits remain.
            # Check ancestry to recognize content already contained in the target branch.
            # The Hub mirror can verify this independently of whether the Runner performed the merge.
            # If the Hub cannot fetch the repository, fail the containment check safely.
            already = bool(hinted.get("merged"))
            if not already and hinted.get("ok") and repo.server_dir:
                already = await asyncio.to_thread(
                    git_ops.branch_merged, repo.server_dir, br, repo.merge_branch,
                    scm.get("provider") == "runner", git_creds, str(t.id))
            if already:
                commit = expected or actual
                if not commit:
                    return {**state, "stage": "none", "branch": br,
                            "error": "代码已在目标分支中，但缺少可固定的提交指纹"}
                commits = [{"sha": commit, "subject": "已存在于目标分支的验证版本"}]
                detail = {"branch": br, "target": repo.merge_branch,
                          "commits": commits, "n": 1,
                          "files": hinted.get("files") or [], "scm": scm,
                          "adoptedExisting": True}
                task_events.record(session, t.id, EV_COMMITTED, detail, actor=who)
                state.update(stage="committed", branch=br, target=repo.merge_branch,
                             commits=commits, files=detail["files"], scm=scm)
                artifact, _created = await release_control.ensure_code_candidate(
                    session, t, state, who)
                task_events.record(session, t.id, EV_MERGED, {
                    "ok": True, "branch": br, "target": repo.merge_branch,
                    "commit": commit, "conflict": False, "error": "", "tail": "",
                    "scm": scm, "alreadyMerged": True}, actor=who)
                await release_control.mark_merged(session, t, commit, who)
                await session.commit()
                return {**state, "stage": "merged", "mergeCommit": commit,
                        "artifactVersionId": artifact.id, "delivered": False,
                        "error": "", "alreadyMerged": True}
            return {**state, "stage": "none", "branch": br,
                    "error": hinted.get("error") or
                             f"执行会话所在分支 {br} 相对 {repo.merge_branch} 没有远端新提交"}
        info = hinted
    else:
        if not str(repo.server_dir or "").strip():
            return {**state, "stage": "none",
                    "error": "执行会话没有上报代码分支；请从需求的 Runner 会话重试交付"}
        ready = await _ensure_repo(repo, t, git_creds or {})
        if not ready.get("ok"):
            return {**state, "stage": "none",
                    "error": str(ready.get("error") or "服务端仓库未就绪")[:500]}
        br = await asyncio.to_thread(
            git_ops.find_task_branch, repo.server_dir, t.id, git_creds, str(t.id))
        info = None
    if not br:
        # An absent task branch means no matching pushed submission was found.
        return {**state, "stage": "none",
                "error": f"没找到属于这条需求的分支（约定名字里要带 {t.id}）"}
    if info is None:
        info = await asyncio.to_thread(git_ops.branch_commits, repo.server_dir, br,
                                       repo.merge_branch, 20, False,
                                       git_creds, str(t.id))  # find_task_branch has already fetched remote state.
    if not info.get("commits"):
        return {**state, "stage": "none", "branch": br,
                "error": info.get("error") or f"分支 {br} 相对 {repo.merge_branch} 没有新提交"}

    # Record first discovery or a changed branch; candidate checksums also detect new commits.
    # Rework commonly pushes to the same branch, so branch names alone are insufficient.
    old_head = str((((state.get("commits") or [{}])[0] or {}).get("sha") or ""))
    new_head = str((((info.get("commits") or [{}])[0] or {}).get("sha") or ""))
    if state["stage"] in ("none", "conflict") or state["branch"] != br or old_head != new_head:
        task_events.record(session, t.id, EV_COMMITTED,
                           {"branch": br, "target": repo.merge_branch,
                            "commits": info["commits"][:20], "n": len(info["commits"]),
                            "files": info.get("files") or [], "scm": scm,
                            "containsTarget": bool(info.get("containsTarget"))}, actor=who)
    state.update(stage="committed", branch=br, target=repo.merge_branch,
                 commits=info["commits"][:20], files=info.get("files") or [], scm=scm,
                 containsTarget=bool(info.get("containsTarget")))

    artifact, created = await release_control.ensure_code_candidate(session, t, state, who)
    await session.commit()
    release = await release_control.view(session, t.id)
    if created:
        await notify_reviewer(
            session, t,
            f"代码已提交到 {br}，候选版本 v{artifact.seq} 正等你审阅；尚未合并")
    return {**state, "stage": "committed", "delivered": False,
            "artifactVersionId": artifact.id, "release": release}


# Explicit merge after authorization.
async def ship(session: AsyncSession, t, repo, branch: str, who: str = "SoduWork",
               git_creds: dict | None = None, scm: dict | None = None) -> dict:
    """Merge the authorized immutable candidate into its target branch. Deployment is a separate
    command and run; merge approval does not authorize production deployment.
    """
    scm_support.require_active(repo)
    artifact, allowed = await release_control.merge_authorization(session, t.id)
    if not allowed:
        return {"ok": False, "stage": "approval", "error": "当前代码版本还没有获得合并授权"}
    if artifact and artifact.branch and artifact.branch != branch:
        return {"ok": False, "stage": "approval", "error": "审批绑定的分支已经变化，请重新审阅"}
    route = dict(scm or {})
    if route.get("provider") == "runner":
        from . import ai_remote
        r = await asyncio.to_thread(ai_remote.git_merge_sync, route, {
            "gitUrl": repo.git_url, "branch": branch, "target": repo.merge_branch,
            "git": git_creds or {}, "taskId": str(t.id)})
    else:
        r = await asyncio.to_thread(
            git_ops.merge_to, repo.server_dir, branch, repo.merge_branch,
            git_creds, str(t.id))
    task_events.record(session, t.id, EV_MERGED,
                       {"ok": r.get("ok"), "branch": branch, "target": repo.merge_branch,
                        "commit": r.get("commit", ""), "conflict": bool(r.get("conflict")),
                        "error": r.get("error", ""), "tail": r.get("output", ""),
                        "scm": route}, actor=who)
    await session.commit()
    if not r.get("ok"):
        await notify_owner(session, t, f"合并到 {repo.merge_branch} 失败：{str(r.get('error',''))[:80]}")
        # Keep the immutable route beside the Git diagnostic.  The workflow
        # rework loop runs on the task branch, so it must know which protected
        # target to merge *into that branch* before the platform retries its
        # deterministic merge.  Credentials are deliberately never included.
        return {**r, "branch": branch, "target": repo.merge_branch}
    await release_control.mark_merged(session, t, r.get("commit", ""), who)
    await session.commit()
    return {"ok": True, "branch": branch, "target": repo.merge_branch, "commit": r.get("commit", "")}


async def _merge_approved_unleased(session: AsyncSession, t, who: str = "SoduWork") -> dict:
    """Refresh the candidate and merge under one task lock. New content invalidates old
    authorization before ship runs; already-merged candidates return idempotently without
    further Git operations.
    """
    repo = await repo_for(session, t)
    scm_support.require_active(repo)
    if repo is None:
        return {"ok": False, "stage": "config", "error": "这条需求没落在配好代码交付的工程上"}
    git_creds = await _task_git_creds(session, t)
    async with _merge_lock(t.id):
        state = await read_state(session, t.id)
        if state["stage"] == "merged":
            return await _after_merge(session, t, {"ok": True, **state, "already": True}, who)
        state = await _check_locked(
            session, t, repo, state, who, str(state.get("branch") or ""),
            git_creds=git_creds, scm_hint=dict(state.get("scm") or {}))
        if state.get("stage") == "merged":
            # If the content is already in the target branch, finalize idempotently without another Git operation.
            return await _after_merge(session, t, {"ok": True, **state, "already": True}, who)
        if state.get("stage") != "committed" or not state.get("branch"):
            return {"ok": False, **state,
                    "error": state.get("error") or "尚未发现可合并的代码提交"}
        out = await ship(session, t, repo, state["branch"], who, git_creds,
                         dict(state.get("scm") or {}))
        if not out.get("ok"):
            return {**state, **out}
        merged = {**state, **out, "stage": "merged", "delivered": False}
        return await _after_merge(session, t, merged, who)


async def merge_approved(session: AsyncSession, t, who: str = "SoduWork") -> dict:
    repo = await repo_for(session, t)
    scm_support.require_active(repo)
    if repo is None:
        return {"ok": False, "stage": "config",
                "error": "This task has no delivery-ready repository mapping"}
    key = f"{repo.id}:{repo.merge_branch or repo.default_branch}"
    try:
        lease = await resource_leases.acquire(
            session, "repository-merge", key, ttl_seconds=900,
            detail={"taskId": str(t.id), "repoId": str(repo.id),
                    "targetBranch": str(repo.merge_branch or repo.default_branch)})
    except resource_leases.LeaseBusy:
        return {"ok": False, "stage": "busy",
                "error": "Another delivery is updating this target branch; retry shortly"}
    try:
        return await _merge_approved_unleased(session, t, who)
    except Exception:
        await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)

async def _after_merge(session: AsyncSession, t, merged: dict, who: str) -> dict:
    """Follow declared environment-promotion policy when deployment targets exist; otherwise use
    legacy merge-completes-delivery behavior.
    """
    from . import deployments
    if await deployments.has_targets(session, t):
        deployment = await deployments.queue_automatic(session, t, who)
        complete = await deployments.delivery_complete(session, t)
        if complete:
            await settle_delivered(session, t, merged, who)
        complete = bool(complete and t.status == "done")
        return {**merged, "delivered": complete, "deployment": deployment}
    # A production-delivery plugin requires deployment configuration.
    # Do not claim delivery merely because merging succeeded; the deploy node reports missing configuration.
    from .. import automation_models as am
    active_workflow = await session.scalar(select(am.WorkflowRun.id).where(
        am.WorkflowRun.task_id == t.id,
        am.WorkflowRun.state.in_(("queued", "running", "waiting_human", "waiting_external"))
    ).limit(1))
    if active_workflow:
        return {**merged, "delivered": False,
                "deployment": {"skipped": "研发工作流要求配置环境部署目标与推进策略"}}
    await settle_delivered(session, t, merged, who)
    if t.status != "done":
        return {**merged, "delivered": False, "deployment": {
            "skipped": "需求\u7531\u5de5\u4f5c\u6d41\u7edf\u4e00\u7ed3\u7b97"
        }}
    return {**merged, "delivered": True, "deployment": {"skipped": "这个仓库没有部署目标"}}


# Delivery completion.
async def settle_delivered(session: AsyncSession, t, state: dict, who: str = "SoduWork") -> None:
    """Complete legacy direct code-delivery tasks after merging; plugin workflows manage their own
    completion.
    """
    n = len(state.get("commits") or [])
    what = f"代码已合进 {state.get('target') or '目标分支'}（{n} 个提交）"
    if t.status not in ("done", "cancel"):
        from . import task_status
        await task_status.mark(session, t, "done", why="code_delivery 交付结算")
    await session.commit()
    await notify_owner(session, t, what)


async def notify_reviewer(session: AsyncSession, t, what: str) -> None:
    """Notify the task creator to review new outputs or a new code candidate."""
    from ..realtime import hub
    cid = getattr(t, "created_by", None)
    if not cid:
        return
    box = (await session.execute(
        select(models.Client.id).where(models.Client.user_ref == cid).limit(1))).scalar()
    if box:
        await hub.publish(box, {"type": "notice",
                                "text": f"AI 完成了「{t.title}」：{what}（可在需求详情里审核）",
                                "taskId": t.id}, user_id=cid)


# Background delivery discovery.
async def sweep(session: AsyncSession) -> dict:
    """Discover candidates only after AI execution finishes and commits are pushed. Reuse
    throttled, idempotent check; never merge automatically from this sweep.
    """
    from . import ai_exec
    rows = (await session.execute(
        select(models.Task).where(models.Task.status.in_(("todo", "doing"))))).scalars().all()
    if not rows:
        return {"checked": 0, "candidates": 0}
    ctx = await ai_exec.load(session)
    if not ai_exec.configured(ctx):
        return {"checked": 0, "candidates": 0, "skipped": "AI 执行没配好"}
    checked = candidates = 0
    for t in rows:
        if (await repo_for(session, t)) is None:
            continue                                  # Skip tasks that do not use code delivery.
        if await managed_by_active_workflow(session, t.id):
            continue                                  # Plugin quality and review nodes own candidate discovery.
        st = await read_state(session, t.id)
        if st["stage"] == "merged" or st["conflict"]:
            continue                                  # Skip completed deliveries and conflicts awaiting intervention.
        ev_row = await ai_exec.last_dispatch_event(session, t.id)
        if ev_row is None:
            continue
        d = ev_row.detail or {}
        ref = d.get("ref") or d.get("issueId", "")
        if not ref:
            continue
        try:
            info = await asyncio.to_thread(ai_exec.runner_info_sync, ctx, ref)
        except Exception:  # noqa: BLE001
            continue
        if not (info or {}).get("done"):
            continue                                  # Wait for execution to finish before checking delivery.
        checked += 1
        try:
            status = dict(await asyncio.to_thread(ai_exec.status_sync, ctx, ref) or {})
        except Exception:  # noqa: BLE001 - keep the sweep available during a transient status read
            status = {}
        scm_hint = ({"provider": "runner", "runnerId": str(d.get("runnerId") or ""),
                     "ref": ref} if d.get("runnerId") else {})
        try:
            before = (await release_control.view(session, t.id)).get("artifact")
            out = await check(
                session, t, who="SoduWork",
                branch_hint=str(status.get("gitRemoteBranch") or status.get("gitBranch") or ""),
                head_hint=str(status.get("gitHead") or ""),
                scm_hint=scm_hint)
            after = (out.get("release") or {}).get("artifact")
            if after and (not before or before.get("id") != after.get("id")):
                candidates += 1
                log.info("交付巡检发现「%s」的新候选版本：%s", t.title, after.get("id"))
        except Exception as e:  # noqa: BLE001
            log.warning("巡检合并失败 %s: %s", t.id, e)
    return {"checked": checked, "candidates": candidates}


async def sweep_loop() -> None:
    """Run the lifespan delivery sweep independently of automatic dispatch settings; manual and
    automatic tasks share delivery rules.
    """
    from ..config import get_settings
    from ..db import SessionLocal
    gap = max(60, int(getattr(get_settings(), "delivery_sweep_seconds", 120)))
    log.info("代码交付巡检启动，间隔 %ss", gap)
    while True:
        try:
            async with SessionLocal() as session:
                out = await sweep(session)
            if out.get("candidates"):
                log.info("交付巡检：发现 %s 个待审阅候选版本", out["candidates"])
            # Also collect non-code outputs in this loop.
            # Document and spreadsheet outputs must return without a user opening task details.
            # Completed workspace files alone are not visible task attachments.
            from . import artifacts_sweep as _asw
            async with SessionLocal() as session:
                a = await _asw.sweep(session)
            if a.get("pulled"):
                log.info("产出巡检：收回 %s 条任务的产出", a["pulled"])
        except asyncio.CancelledError:
            log.info("代码交付巡检停止")
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("交付巡检异常：%s", e)
        await asyncio.sleep(gap)


async def notify_owner(session: AsyncSession, t, text: str) -> None:
    from ..realtime import hub
    if getattr(t, "owner_client_id", None):
        await publish_owner(session, t, {"type": "notice",
                                              "text": f"「{t.title}」{text}", "taskId": t.id})
