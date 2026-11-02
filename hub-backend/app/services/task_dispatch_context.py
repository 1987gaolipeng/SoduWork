"""Shared dispatch context, workspace planning and task receipt publication."""
import logging
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from ..models import Client, Task
from ..realtime import hub
from .task_access import publish_task

log = logging.getLogger("uvicorn.error")


async def _remote_execution_context(session, client, ctx, body, aid, task,
                                    personal_plugin=None):
    """Honor an explicit remote choice without broadening default device scope."""
    from . import ai_exec, ai_exec_route, conversation_handoffs, runner_hub
    raw = body.get("executionContext")
    selection = raw if isinstance(raw, dict) else {}
    location = selection.get("location")
    location = location if isinstance(location, dict) else {}
    runner = selection.get("runner")
    runner = runner if isinstance(runner, dict) else {}
    modes = {str(item.get("mode") or "") for item in (location, runner)} - {""}
    if "remote" not in modes:
        return ctx, aid
    if modes != {"remote"} or personal_plugin:
        raise HTTPException(409, "执行位置与所选工作方法不一致，请刷新后重新选择")
    rid = str(runner.get("runnerId") or runner.get("id") or "").strip()
    cli = ai_exec_route.cli_of(aid)
    if not rid or not cli:
        raise HTTPException(409, "请选择明确的远程执行机和执行底座")
    target_id = "runner:" + rid + ":" + cli
    if aid.startswith("runner:") and aid != target_id:
        raise HTTPException(409, "执行底座与所选执行机不一致，请刷新后重新选择")
    picked = await conversation_handoffs.destination(session, client, {
        "assigneeId": target_id, "agentId": cli,
        "model": str(body.get("model") or ""),
        "targetRunnerKind": str(runner.get("runnerKind") or ""),
        "requiredSkills": list((task.work_routing or {}).get("requiredSkills") or []),
    })
    selected_client = str(runner.get("clientId") or "")
    if selected_client and selected_client != str(picked.get("clientId") or ""):
        raise HTTPException(409, "目标执行机归属已变化，请刷新后重新选择")
    live = runner_hub.get(rid)
    if not live or not runner_hub.supports_capabilities(live, ai_exec.required_capabilities(task)):
        raise HTTPException(409, "所选执行机尚未具备这项工作需要的全部能力")
    return conversation_handoffs.scope_for_destination(ctx, client, picked), target_id


async def _ext_project_id(session, t) -> str:
    """Resolve the task project's explicit provider-side project ID, or empty to use the provider's
    default location.
    """
    from ..models import Project
    pid = getattr(t, "project_id", None)
    if not pid:
        return ""
    p = await session.get(Project, pid)
    return (getattr(p, "ext_project_id", "") or "") if p else ""


def _repo_ctx(body: dict) -> dict:
    """Normalize supplied repository execution context, including device-local path and repository
    ID. Validate shape and length without inferring remote filesystem paths.
    """
    r = body.get("repo") or {}
    if not isinstance(r, dict):
        return {}
    path = str(r.get("path") or "").strip()
    rid = str(r.get("id") or "").strip()
    git_url = str(r.get("gitUrl") or "").strip()
    if not path and not rid and not git_url:
        return {}
    return {"id": rid[:64],
            "path": path[:400], "name": str(r.get("name") or "")[:120],
            "kind": str(r.get("kind") or "")[:16], "gitUrl": str(r.get("gitUrl") or "")[:512],
            "branch": str(r.get("branch") or "")[:120], "note": str(r.get("note") or "")[:2000],
            "flow": bool(r.get("flow")),
            # Unattended autobatch execution disables GUI screenshots.
            # Override always-screenshot settings because unattended GUI capture can stall.
            "unattended": bool(r.get("unattended"))}


async def _resolve_repo(session: AsyncSession, repo_ctx: dict):
    """Resolve the selected repository by ID, falling back to Git URL only when it identifies
    exactly one repository.
    """
    if not repo_ctx:
        return None
    from sqlalchemy import select as _sel

    from ..models import Repo
    rid = (repo_ctx.get("id") or "").strip()
    if rid:
        r = await session.get(Repo, rid)
        if r:
            return r
    gu = (repo_ctx.get("gitUrl") or "").strip()
    if gu:
        rows = (await session.execute(_sel(Repo).where(Repo.git_url == gu))).scalars().all()
        if len(rows) == 1:
            return rows[0]
    return None


async def _attach_dev_flow(session: AsyncSession, repo_ctx: dict, repo=None) -> None:
    """Merge global and project development-flow settings before passing one complete configuration
    to adapters. Skip the lookup when the flow is disabled.
    """
    if not repo_ctx or not repo_ctx.get("flow"):
        return
    from ..services import ai_prompts
    if repo is None:
        repo = await _resolve_repo(session, repo_ctx)
    repo_ctx["devFlow"] = await ai_prompts.resolve(session, repo)



async def _attach_skills(session: AsyncSession, extra: dict, repo_ctx: dict | None,
                         client: Client | None = None) -> None:
    """Resolve product-level skill selection into execution context; adapters only decide how to
    pass it through native arguments or prompt text.
    """
    from ..services import skills as _skills
    try:
        selected = await _skills.resolve(
            session, (repo_ctx or {}).get("id") or "", client)
    except Exception as e:      # noqa: BLE001 - Skill discovery failure must not disable the entire dispatch path.
        selected = []
        log.warning("技能解析失败：%s", type(e).__name__)
    required = await _skills.resolve_named(
        session, extra.get("requiredSkills") or [], client)
    merged = {}
    for item in selected + required:
        merged[str(item.get("name") or "")] = item
    extra["skills"] = list(merged.values())
    # MCP failure must not erase already-resolved skills; these are independent capability paths.
    if any(s.get("name") == "mcp-tools" for s in extra["skills"]):
        try:
            from ..services import mcp_servers as _mcp
            extra["mcpServers"], extra["mcpConfig"] = await _mcp.runtime_for_dispatch(
                session, client=client,
                variables={
                    "SODUWORK_WORK_ROOT": str(extra.get("workRoot") or ""),
                    "SODUWORK_WORK_DIR": str(extra.get("workDir") or ""),
                })
        except Exception as e:  # noqa: BLE001
            extra["mcpServers"], extra["mcpConfig"] = "", {"servers": {}}
            extra["capabilityWarnings"] = list(extra.get("capabilityWarnings") or []) + [
                "MCP 配置未能装载，请检查能力中心"]
            log.warning("MCP 配置装载失败：%s", type(e).__name__)


def _fill_repo_wire(repo_ctx: dict, repo) -> None:
    """Populate repository fields required for the Runner's initial clone."""
    if repo is None or repo_ctx is None:
        return
    for key, value in (("id", getattr(repo, "id", "")),
                       ("name", getattr(repo, "name", "")),
                       ("gitUrl", getattr(repo, "git_url", "")),
                       ("branch", getattr(repo, "default_branch", ""))):
        if not repo_ctx.get(key):
            repo_ctx[key] = str(value or "")
    repo_ctx["localDir"] = str(getattr(repo, "local_dir", "") or "")


async def _settle_work_dir(session, client, repo, repo_ctx: dict, task_id: str,
                           remote: bool = False) -> dict:
    """Behavior and constraints for this operation."""
    from ..services import code_creds, scm_support, workdirs
    scm_support.require_active(repo if repo is not None else repo_ctx)
    root = workdirs.work_root_of(client)
    _fill_repo_wire(repo_ctx, repo)
    if remote:
        # For remote execution, send a workspace plan without creating directories or cloning remote paths on Hub.
        # The selected Runner resolves its reported workRoot; the supplied root supports same-host legacy execution only.
        return {"ok": True, "dir": (repo_ctx or {}).get("path", ""),
                "workRoot": root, "cloned": False, "remote": True}
    creds = None
    try:
        cid = str(getattr(client, "id", "") or "")
        if cid:
            creds = code_creds.resolve(client)
    except Exception:  # noqa: BLE001
        creds = None
    r = await _aio_thread(workdirs.plan, root, repo,
                          task_id, (repo_ctx or {}).get("path", ""), creds)
    # Send the explicitly authorized work root with the execution directory.
    # Adapters must not infer broader permissions by walking parents with varying directory layouts.
    r["workRoot"] = root
    # Set repo.path only when a repository is actually associated.
    # Adding a key to an empty context would change its truthiness.
    # Downstream code uses that truthiness to select development and skill behavior.
    # Pass non-project temporary directories through workDir instead.
    if r.get("ok") and r.get("dir") and repo is not None and repo_ctx is not None:
        repo_ctx["path"] = str(r["dir"])[:400]
    return r


async def _aio_thread(fn, *a):
    import asyncio as _a
    return await _a.to_thread(fn, *a)


def _link_task_repo(t, repo) -> None:
    """Fill a task's missing project and repository association during dispatch so delivery checks
    resolve the correct repository. Preserve existing user-configured project ownership.
    """
    if not repo:
        return
    if not (getattr(t, "project_id", None) or "").strip():
        t.project_id = repo.project_id
    if not (getattr(t, "repo_id", "") or "").strip():
        t.repo_id = repo.id


async def _stale_runner_hint(session: AsyncSession, stage: str, message, picked) -> str:
    """Explain an outdated runner version when an Agent fails to start.
    
    Include the affected runner and version comparison so the user can identify which device
    needs updating. If a detached session already started despite a dispatch-receipt failure,
    the heartbeat-side _heal_lost_dispatch logic reconnects it automatically.
    """
    text = str(message or "")
    if stage != "dispatch" or not picked:
        return text
    runner_id = str((picked or {}).get("runnerId") or "")
    if not runner_id:
        return text
    try:
        from ..automation_models import RunnerNode
        from ..services import runner_release
        row = await session.get(RunnerNode, runner_id)
        state = runner_release.release_state(str(getattr(row, "version", "") or ""))
        if row is not None and state["upgradeAvailable"]:
            text += ("；执行机 %s 版本 %s 低于服务端配套 %s——多半是老执行机的缺陷，"
                     "请先升级那台机器上的 SoduWork 客户端或执行机再试" % (
                         str(row.host or runner_id), state["currentVersion"] or "未知",
                         state["targetVersion"]))
    except Exception:  # noqa: BLE001 - Optional guidance must not interfere with failure persistence.
        pass
    return text


async def _push_task(session: AsyncSession, t: Task, created: bool) -> dict | None:
    """Push authorized task projections without affecting committed operations."""
    if not t.owner_client_id:
        return None
    from ..services.tasks import task_to_api_live
    task_api = await task_to_api_live(session, t)
    try:
        await publish_task(session, t, "task." + ("created" if created else "updated"), task_api)
    except Exception as e:  # noqa: BLE001
        log.warning("推送任务变更失败：%s", type(e).__name__)
    return task_api
