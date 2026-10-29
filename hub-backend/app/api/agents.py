"""Device-authenticated APIs for installing and configuring local AI assistants on their actual
execution machines. Prefer the online desktop Runner, otherwise use the backend execution
machine. Long operations return a jobId for progress polling; software installation affects the
shared machine.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client
from ..models import Client
from ..services import agent_setup, model_catalog, runner_hub
from ..services.cluster_bus import bus

router = APIRouter(prefix="/api/v1", tags=["agents"])


def _runner_job(rid: str, jid: str) -> str:
    return "runner|%s|%s" % (rid, jid)


def _runner_job_parts(jid: str) -> tuple[str, str]:
    parts = str(jid or "").split("|", 2)
    return (parts[1], parts[2]) if len(parts) == 3 and parts[0] == "runner" else ("", "")


async def _runner_call(r, op: str, data: dict, timeout: int = 60) -> dict:
    res = await r.call(op, data, timeout=timeout)
    if not res.get("ok"):
        raise HTTPException(status_code=503, detail=res.get("error") or "桌宠执行机没有应答")
    return dict(res.get("data") or {})


@router.get("/agent-setup")
async def get_agent_setup(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return agent installation status and model availability for this client's effective
    credentials, including personal keys.
    """
    usable = await model_catalog.usable(session, client)
    # List installed runtimes separately for every machine owned by the current user.
    # runner_hub.for_client() selects only one Runner by availability and connection time.
    # A user may own several Runners, so a single selection cannot represent all machines.

    # Installation and removal are machine-scoped operations and must target the selected device.
    machines = await _machines(session, client, bool(usable))
    data = {
        "machines": machines,
        "modelCount": len(usable),
        # Retain top-level env/agents from the first machine for older clients; newer clients use machines.
        "env": (machines[0]["env"] if machines else {}),
        "agents": (machines[0]["agents"] if machines else []),
        "execution": (machines[0]["execution"] if machines else ("runner" if bus.enabled else "backend")),
    }




    data["models"] = [{"name": m["name"], "label": m.get("label") or m["name"],
                       "provider": m.get("providerName") or m.get("providerId", ""),
                       "keyFrom": m.get("keyFrom", "")} for m in usable]
    default_model = usable[0]["name"] if usable else ""
    for m in machines:
        for a in m.get("agents") or []:
            if not isinstance(a, dict):
                continue
            picked = model_catalog.agent_model(client, a.get("key", ""))
            a["modelPick"] = bool(a.get("needsLlm"))
            a["model"] = picked
            # Report unavailable selections immediately, before dispatch.
            a["modelGone"] = bool(picked and not any(x["name"] == picked for x in usable))
            a["modelEffective"] = picked if (picked and not a["modelGone"]) else default_model
    return data


async def _machines(session: AsyncSession, client: Client, has_model: bool) -> list[dict]:
    """List agent installations on every execution machine, using the shared display-name
    precedence: custom name, host and OS, then shortened ID.
    """
    from ..services import agent_naming, execution_aliases
    aliases = await execution_aliases.load(session)
    # Personal cloud Runners authenticate without a desktop client id. They
    # still belong to the current account and must be visible for Harness
    # installation and probing.
    runners = [r for r in runner_hub.online()
               if r.client_id == client.id or
               (not r.client_id and str(getattr(r, "owner_user_id", "")) == str(client.user_ref or ""))]
    runners.sort(key=lambda r: r.connected_at)

    labels = agent_naming.unique_machine_labels([{
        "key": agent_naming.machine_key(host=r.host, runner_id=r.id),
        "alias": execution_aliases.machine_name(
            aliases, agent_naming.machine_key(host=r.host, runner_id=r.id)),
        "host": r.host, "osName": getattr(r, "os", ""), "runnerId": r.id,
        "person": getattr(r, "owner_name", ""),
    } for r in runners])

    out: list[dict] = []
    for r in runners:
        mkey = agent_naming.machine_key(host=r.host, runner_id=r.id)
        try:
            data = await _runner_call(r, "agent.setup", {"hasModel": has_model})
        except Exception as e:  # noqa: BLE001  A failed probe must not hide other machines.
            out.append({"runnerId": r.id, "machineKey": mkey,
                        "label": labels.get(mkey) or r.host or r.id[:12],
                        "host": r.host, "os": getattr(r, "os", ""), "execution": "runner",
                        "env": {"ok": False, "why": "这台执行机没有应答（%s）" % type(e).__name__},
                        "agents": []})
            continue
        out.append({"runnerId": r.id, "machineKey": mkey,
                    "label": labels.get(mkey) or r.host or r.id[:12],
                    "host": r.host, "os": getattr(r, "os", ""), "execution": "runner",
                    "env": data.get("env") or {}, "agents": data.get("agents") or []})
    if not out and not bus.enabled:
        # Without connected Runners, use the backend machine's local executors for compatibility.
        from ..services import ai_local
        host = ai_local.local_host()
        mkey = agent_naming.machine_key(host=host)
        out.append({"runnerId": "", "machineKey": mkey,
                    "label": execution_aliases.machine_name(aliases, mkey)
                    or agent_naming.auto_machine_label(host=host, fallback="服务端"),
                    "host": host, "os": "", "execution": "backend",
                    "env": agent_setup.node_env(),
                    "agents": agent_setup.detect_all(has_model=has_model)})
    return out


def _pick_runner(client: Client, runner_id: str):
    """Target installation, removal, and probes at the explicitly selected machine; use legacy
    selection only when no machine is specified.
    """
    want = str(runner_id or "").strip()
    if not want:
        runner = runner_hub.for_client(client.id)
        if runner is None and bus.enabled:
            raise HTTPException(status_code=409,
                                detail="当前没有在线执行机，请先连接本机或远程 Runner")
        return runner
    r = runner_hub.get(want)
    if r is None or not (r.client_id == client.id or
                         (not r.client_id and str(getattr(r, "owner_user_id", "")) == str(client.user_ref or ""))):
        raise HTTPException(status_code=404, detail="这台执行机不在线，或者不是你的")
    return r


@router.put("/agent-setup/model")
async def put_agent_model(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Store per-agent choices in Client.agent_models. Empty model clears the override and restores
    the client's default.
    """
    key = str(body.get("key") or "").strip().lower()
    if key not in agent_setup._SPECS:
        raise HTTPException(status_code=404, detail="没有这个 AI 助手")
    name = str(body.get("model") or "").strip()[:160]
    if name:
        lst = await model_catalog.usable(session, client)
        if not any(m["name"] == name for m in lst):
            raise HTTPException(status_code=422, detail="这个模型你现在用不了，换一个或先去「我的模型」配 key")
    table = dict(getattr(client, "agent_models", None) or {})
    if name:
        table[key] = name
    else:
        table.pop(key, None)
    client.agent_models = table
    await session.commit()
    return {"ok": True, "key": key, "model": name}


@router.post("/agent-setup/install")
async def post_agent_install(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
):
    """Start a machine-level installation, upgrade, removal, or version check and return jobId. The
    UI confirms the target and shared-machine impact before execution.
    """
    key = str(body.get("key") or "").strip()
    action = str(body.get("action") or "install").strip()
    if key not in agent_setup._SPECS:
        raise HTTPException(status_code=404, detail="没有这个 AI 助手")
    if action not in ("install", "update", "uninstall", "check", "login", "login-isolated", "login-cancel") or (action.startswith("login") and key != "codex"):
        raise HTTPException(status_code=400, detail="不认识的操作")
    runner = _pick_runner(client, body.get("runnerId"))
    if action == "login-cancel":
        jid = str(body.get("jobId") or "").strip()
        rid, native_jid = _runner_job_parts(jid)
        if not jid or (runner is not None and (rid != runner.id or not native_jid)) or (runner is None and "|" in jid):
            raise HTTPException(status_code=400, detail="授权任务与所选执行机不匹配，请重新检查")
        if runner is not None:
            result = await _runner_call(runner, "agent.install", {
                "key": key, "action": action, "jobId": native_jid, "ownerId": str(client.id)}, timeout=60)
            return {"jobId": jid, "cancelled": bool(result.get("cancelled")),
                    "state": result.get("state", "cancelling")}
        try:
            return agent_setup.cancel_login(jid, owner_id=str(client.id))
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
    if runner is not None:
        payload = {"key": key, "action": action}
        if action.startswith("login"):
            payload["ownerId"] = str(client.id)
        data = await _runner_call(runner, "agent.install", payload, timeout=60)
        return {"jobId": _runner_job(runner.id, str(data.get("jobId") or ""))}
    installer = str((agent_setup._SPECS.get(key) or {}).get("installer") or "npm")
    if not action.startswith("login") and not agent_setup.is_bundled(key) and installer == "npm":
        env = agent_setup.node_env()
        if not env["ok"]:
            raise HTTPException(status_code=400, detail=env["why"])
    return {"jobId": agent_setup.start_install(key, action, owner_id=str(client.id))
            if action.startswith("login") else agent_setup.start_install(key, action)}


@router.post("/agent-setup/probe")
async def post_agent_probe(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Run a minimal real probe with model_catalog.resolve and the same effective personal or
    company credentials as dispatch; return jobId.
    """
    key = str(body.get("key") or "").strip()
    if key not in agent_setup._SPECS:
        raise HTTPException(status_code=404, detail="没有这个 AI 助手")
    # Probe the exact model selected for this agent.
    # A successful probe must exercise the same configuration as subsequent dispatch.
    llm = await model_catalog.resolve_for_agent(session, client, key, str(body.get("model") or ""))
    runner = _pick_runner(client, body.get("runnerId"))
    jid = (str((await _runner_call(runner, "agent.probe", {"key": key, "llm": llm}, timeout=60)).get("jobId") or "")
           if runner is not None else agent_setup.start_probe(key, llm))
    return {"jobId": _runner_job(runner.id, jid) if runner is not None else jid,
            "model": llm.get("model", ""),
            "fellBackFrom": llm.get("fellBackFrom", ""),
            "keyFrom": llm.get("keyFrom", "")}


@router.post("/agent-setup/configure")
async def post_agent_configure(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Rewrite configuration without executing a task, for repairing manually damaged configuration
    files.
    """
    key = str(body.get("key") or "").strip()
    if key not in agent_setup._SPECS:
        raise HTTPException(status_code=404, detail="没有这个 AI 助手")
    llm = await model_catalog.resolve_for_agent(session, client, key, str(body.get("model") or ""))
    runner = _pick_runner(client, body.get("runnerId"))
    if runner is not None:
        return await _runner_call(runner, "agent.configure", {"key": key, "llm": llm}, timeout=60)
    return agent_setup.configure(key, llm)


# Git and Gerrit credentials.
@router.get("/my-git")
async def get_my_git(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return the client's Git identity, masked credential metadata, and configured repository URLs
    suitable for a connection probe.
    """
    from sqlalchemy import select

    from ..models import Repo
    from ..services import code_creds
    repos = (await session.execute(select(Repo))).scalars().all()
    return {
        "git": code_creds.api_view(client),
        "repos": [{"id": r.id, "name": r.name, "url": r.git_url}
                  for r in repos if (r.git_url or "").strip()],
    }


@router.put("/my-git")
async def put_my_git(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Save code credentials: omitted token/key preserves the value; null removes it."""
    from ..services import code_creds
    err = code_creds.save(client, body)
    if err:
        raise HTTPException(status_code=400, detail=err)
    await session.commit()
    await session.refresh(client)
    return {"ok": True, "git": code_creds.api_view(client)}


@router.post("/my-git/test")
async def test_my_git(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Probe credentials with read-only git ls-remote. The client must save current input before
    probing so the check uses the intended credentials.
    """
    import asyncio as _aio

    from ..services import code_creds
    url = str(body.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="要测哪个仓库？挑一个工程，或者自己贴个地址。")
    git = code_creds.resolve(client)
    if not git:
        raise HTTPException(status_code=400, detail="还什么都没配")
    return await _aio.to_thread(code_creds.probe_sync, git, url)


@router.get("/agent-setup/job/{jid}")
async def get_agent_job(jid: str, client: Client = Depends(current_client)):
    """Return job progress and incremental logs while the operation runs."""
    rid, remote_jid = _runner_job_parts(jid)
    if rid:
        runner = runner_hub.get(rid)
        if runner is None or not (runner.client_id == client.id or
                                  (not runner.client_id and str(getattr(runner, "owner_user_id", "")) == str(client.user_ref or ""))):
            raise HTTPException(status_code=404, detail="执行这个作业的桌宠不在线")
        return await _runner_call(runner, "agent.job", {"key": "_", "jobId": remote_jid,
                                                     "ownerId": str(client.id)}, timeout=30)
    if bus.enabled:
        raise HTTPException(status_code=409,
                            detail="这是旧后台本机作业，请在对应 Runner 上重新操作")
    j = agent_setup.job(jid, owner_id=str(client.id))
    if j is None:
        raise HTTPException(status_code=404, detail="没有这个作业（后端可能重启过）")
    return j
