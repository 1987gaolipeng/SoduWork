"""WebSocket terminal transport for registered devices and their owned tasks. Authenticate before
opening a shell, resolve the workspace from execution records, and exchange ready/output/end and
input/resize/kill frames. Keep shell access within the intended internal network boundary.
"""
import asyncio
import json
import os

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketState

from ..db import SessionLocal, get_session
from ..config import get_settings
from ..deps import current_client
from ..models import Client, Task
from ..services import (device_auth, device_connections, environment_service,
                        execution_host_policy, pty_term, runner_hub, task_access)

router = APIRouter()
settings = get_settings()


def _local_support() -> tuple[bool, str]:
    if not execution_host_policy.hub_local_allowed():
        return False, execution_host_policy.local_disabled_result()["error"]
    return pty_term.available()


@router.get("/api/v1/term/support")
async def term_support(client: Client = Depends(current_client)):
    """Report terminal availability and an actionable reason when the machine cannot provide one."""
    ok, why = _local_support()
    return {"ok": ok, "reason": why,
            "shell": " ".join(pty_term.default_shell()) if ok else ""}


@router.get("/api/v1/tasks/{tid}/term")
async def term_info(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    t = await session.get(Task, tid)
    if t is None or not task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    term = pty_term.get(tid)
    from ..services import execution_sessions
    route = await execution_sessions.task_runner_route(session, tid)
    remote_id = route["runnerId"]
    remote = runner_hub.get(remote_id) if remote_id else None
    ok, why = _local_support()
    if remote_id and remote is None:
        ok, why = False, "执行这条活的电脑现在不在线"
    return {"supported": bool(ok or remote), "reason": "" if remote else why,
            "term": term.info() if term else None,
            "runnerId": remote_id, "host": remote.host if remote else route.get("host", "")}


@router.delete("/api/v1/tasks/{tid}/term")
async def term_close(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    t = await session.get(Task, tid)
    if t is None or not task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    from ..services import execution_sessions
    route = await execution_sessions.task_runner_route(session, tid)
    remote = runner_hub.get(route["runnerId"]) if route["runnerId"] else None
    if remote is not None:
        await runner_hub.term_close(remote, tid)
        return {"ok": True}
    return {"ok": pty_term.close_term(tid)}


@router.post("/api/v1/tasks/{tid}/open-dir")
async def open_workdir(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Behavior and constraints for this operation."""
    import asyncio as _aio
    import subprocess
    import sys as _sys

    t = await session.get(Task, tid)
    if t is None or not task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    from ..services import execution_sessions
    route = await execution_sessions.task_runner_route(session, tid)
    remote_id = route["runnerId"]
    if remote_id:
        runner = runner_hub.get(remote_id)
        if runner is None:
            raise HTTPException(status_code=409, detail="执行这条活的电脑现在不在线")
        ref = route["ref"]
        res = await runner.call("job.open_dir", {"ref": ref}, timeout=30)
        if not res.get("ok"):
            raise HTTPException(status_code=404, detail=res.get("error") or "工作目录打不开")
        return {"ok": True, **dict(res.get("data") or {})}
    d = await _workdir_of(tid)
    if not d or not os.path.isdir(d):
        raise HTTPException(status_code=404, detail="这条活没有本机工作目录（多半是托管跑的）")

    def _open():
        if os.name == "nt":
            # Windows Explorer can return a nonzero status after successfully opening a directory.
            subprocess.run(["explorer", os.path.normpath(d)], capture_output=True, timeout=15)
        elif _sys.platform == "darwin":
            subprocess.run(["open", d], capture_output=True, timeout=15)
        else:
            subprocess.run(["xdg-open", d], capture_output=True, timeout=15)
    try:
        await _aio.to_thread(_open)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"打不开（{type(e).__name__}）")
    # Windows has no os.uname; keep platform detection in explicit branches.
    # Avoid conditional-expression precedence that obscures the platform fallback.
    if hasattr(os, "uname"):
        host = os.environ.get("COMPUTERNAME") or os.uname().nodename
    else:
        host = os.environ.get("COMPUTERNAME", "")
    return {"ok": True, "dir": d, "host": host}


async def _workdir_of(tid: str) -> str:
    """Resolve the execution workspace for the terminal; fall back to the local workspace root when
    no valid execution directory exists.
    """
    from ..services import ai_exec, ai_local, execution_sessions
    async with SessionLocal() as s:
        route = await execution_sessions.task_runner_route(s, tid)
        ref = route["ref"]
        if not ref:
            task = await s.get(Task, tid)
            owner = await s.get(Client, task.owner_client_id) if task is not None else None
            root = str(getattr(owner, "work_root", "") or "").strip()
            if root:
                os.makedirs(root, exist_ok=True)
            return root
        ctx = await ai_exec.load(s)
        try:
            info = await asyncio.to_thread(ai_exec.runner_info_sync, ctx, ref)
        except Exception:  # noqa: BLE001
            info = {}
        return (info or {}).get("workDirAbs") or ""


async def _env_for_term(cli: str = "") -> dict:
    """Build the terminal environment for the task's actual CLI. Pi configuration and
    OPENCODE_CONFIG_CONTENT use different credential setup paths.
    """
    from ..services import ai_local
    async with SessionLocal() as s:
        cfg = await ai_local.load(s)
    prof = ai_local._PROFILES.get(cli) or ai_local._PROFILES["opencode"]
    return ai_local._env_for(prof, cfg)


async def _cli_sid_of(tid: str) -> tuple[str, str]:
    """Technical contract for  cli sid of."""
    from ..services import ai_exec, ai_local, execution_sessions
    async with SessionLocal() as s:
        route = await execution_sessions.task_runner_route(s, tid)
    ref = route["ref"]
    if not ref:
        return "", ""
    # Use runner_info for session metadata on both local and remote execution machines.
    try:
        async with SessionLocal() as s:
            ctx = await ai_exec.load(s)
        info = await asyncio.to_thread(ai_exec.runner_info_sync, ctx, ref)
    except Exception:  # noqa: BLE001
        info = {}
    cli = str((info or {}).get("cli") or "")
    sid = str((info or {}).get("cliSid") or "")
    if not sid and cli:
        prof = ai_local._PROFILES.get(cli) or {}
        if prof.get("own_session"):
            sid = ref
    if cli or sid:
        return sid, cli
    run = getattr(ai_local, "_RUNS", {}).get(ref) or {}
    if not run:
        try:
            import json as _json
            import os as _os
            mj = _os.path.join(ai_local._STORE, ref, "meta.json")
            with open(mj, encoding="utf-8") as f:
                run = _json.load(f) or {}
        except Exception:  # noqa: BLE001  Missing session metadata falls back to a shell.
            run = {}
    cli = run.get("cli") or ""
    sid = run.get("cliSid") or ""
    if not sid and cli:
        # For own_session runtimes such as Claude and Pi, ref is the session ID passed at startup.
        # New dispatches persist cliSid, but historical archives may omit it.
        # Infer missing historical IDs without rewriting archived records.
        prof = ai_local._PROFILES.get(cli) or {}
        if prof.get("own_session"):
            sid = ref
    return sid, cli


class _RemoteTerm:
    """Adapt a remote Runner terminal to the local pty_term.Term interface. Schedule asynchronous
    write, resize, and close requests on the event loop while preserving the shared WebSocket
    protocol.
    """

    def __init__(self, runner, task: str):
        self._r = runner
        self._task = task
        self._info: dict = {}

    async def open(self, spec: dict, on_data) -> str:
        res = await runner_hub.term_open(self._r, self._task, spec, on_data)
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "执行机没能开出终端")
        self._info = dict(res.get("info") or {})
        self._info["host"] = self._r.host
        return str(res.get("backlog") or "")

    def info(self) -> dict:
        return self._info

    def write(self, data: str) -> None:
        asyncio.ensure_future(runner_hub.term_write(self._r, self._task, data))

    def resize(self, cols: int, rows: int) -> None:
        asyncio.ensure_future(runner_hub.term_resize(self._r, self._task, cols, rows))

    def close(self) -> None:
        asyncio.ensure_future(runner_hub.term_close(self._r, self._task))

    def unsubscribe(self, fn) -> None:
        # Disconnecting a viewer must not close the remote terminal, allowing refresh and reconnection.
        # Detach callbacks without sending Runner close.
        asyncio.ensure_future(runner_hub.term_detach(self._r, self._task))


async def _serve_terminal(websocket: WebSocket, task: str, cols: int, rows: int,
                          mode: str, rn, execution_ref: str = "") -> None:
    """Open and relay one authenticated terminal after connection registration."""
    # Recheck at the execution boundary, after device registration/revalidation.
    # Reading/closing old terminals remains available, but no interactive Hub
    # shell may be opened or attached while this deployment disables execution.
    if rn is None and not execution_host_policy.hub_local_allowed():
        denied = execution_host_policy.local_disabled_result()
        await websocket.send_json({"t": "err", "d": denied["error"], "code": denied["code"]})
        await websocket.close(code=4403)
        return
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=2000)
    overflow_notified = False

    def on_data(data):
        def enqueue() -> None:
            nonlocal overflow_notified
            if data is None:
                # The terminal-end marker must not be lost behind a burst of output.
                if q.full():
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                q.put_nowait(None)
                return
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                if overflow_notified:
                    return
                overflow_notified = True
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                q.put_nowait("\r\n[SoduWork：终端输出过快，已省略部分滚动画面；需求结果不会受影响。]\r\n")
        try:
            loop.call_soon_threadsafe(enqueue)
        except Exception:  # noqa: BLE001
            pass

    ws_dir = await _workdir_of(task)
    sid, cli = await _cli_sid_of(task)
    if mode != "session":
        sid = ""
    if rn is not None:
        term = _RemoteTerm(rn, task)
        try:
            # Environment and task credentials belong to the execution host.
            # An empty legacy env also makes old Runners inherit their own OS
            # environment instead of receiving any Hub configuration/secrets.
            backlog = await term.open({"ws": ws_dir, "cols": cols, "rows": rows, "env": {},
                                       "mode": mode, "sid": sid, "cli": cli,
                                       "ref": execution_ref}, on_data)
        except Exception as exc:  # noqa: BLE001
            await websocket.send_json({"t": "err", "d": str(exc)[:200]})
            await websocket.close()
            return
    else:
        try:
            env = await _env_for_term(cli)
            term = await asyncio.to_thread(
                pty_term.open_term, task, ws_dir, cols, rows, env, mode, sid, cli)
        except Exception as exc:  # noqa: BLE001
            await websocket.send_json({"t": "err", "d": "终端起不来（%s）" % type(exc).__name__})
            await websocket.close()
            return
        backlog = term.subscribe(on_data)
    await websocket.send_json({"t": "ready", "d": term.info()})
    if backlog:
        await websocket.send_json({"t": "o", "d": backlog})

    async def pump():
        while True:
            data = await q.get()
            if data is None:
                await websocket.send_json({"t": "end", "d": term.info()})
                return
            chunks = [data]
            while not q.empty() and len(chunks) < 64:
                nxt = q.get_nowait()
                if nxt is None:
                    break
                chunks.append(nxt)
            await websocket.send_json({"t": "o", "d": "".join(chunks)})

    pump_task = asyncio.create_task(pump())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except Exception:  # noqa: BLE001
                continue
            kind = message.get("t")
            if kind == "i":
                term.write(str(message.get("d") or ""))
            elif kind == "size":
                term.resize(int(message.get("cols") or 100), int(message.get("rows") or 30))
            elif kind == "kill":
                if rn is not None:
                    await runner_hub.term_close(rn, task)
                else:
                    await asyncio.to_thread(term.close)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        term.unsubscribe(on_data)
        pump_task.cancel()
        await asyncio.gather(pump_task, return_exceptions=True)
        # Retain terminals across viewer disconnects; sweep() handles eventual cleanup.


@router.websocket("/api/v1/term")
async def term_ws(websocket: WebSocket, device: str, task: str,
                  secret: str | None = None, cols: int = 100, rows: int = 30,
                  mode: str = "session", host: str = "",
                  device_session: str | None = Query(default=None, alias="session")):
    if secret is None and device_session is None:
        # Keep credentials out of URLs because proxies and access logs record them.
        # Authenticate in the first frame after accept; retain legacy query authentication only through its compatibility path.
        await websocket.accept()
        resolved = await device_auth.creds_from_first_frame(websocket, device)
        if resolved is None:
            await websocket.send_json({"t": "err", "d": "终端通道鉴权超时：请重新打开控制台再试一次。"})
            await websocket.close(code=4401)
            return
        secret, device_session = resolved

    async def _accept() -> None:
        # Make later accept calls idempotent after first-frame authentication.
        if websocket.client_state == WebSocketState.CONNECTING:
            await websocket.accept()

    route_host = ""
    execution_ref = ""
    async with SessionLocal() as session:
        try:
            c = await device_auth.client_from_transport(
                session, device, device_session=device_session or "",
                secret=secret or "", allow_legacy=settings.device_auth_compat,
            )
        except device_auth.DeviceAuthError:
            c = None
        t = await session.get(Task, task) if c is not None else None
        if t is not None and task_access.is_owner(t, c):
            from ..services import execution_sessions
            route = await execution_sessions.task_runner_route(session, task)
            route_host = route["runnerId"]
            execution_ref = route["ref"]
    # Send an actionable error before closing instead of closing without a response.
    # A generic disconnected message must not imply that the terminal is running or will reconnect.

    if c is None:
        await _accept()
        await websocket.send_json({"t": "err", "d": "这台设备还没在服务端注册，或者身份密钥对不上。"
                                                    "重新登录一次桌宠再打开控制台。"})
        await websocket.close(code=4401)          # Reject unregistered devices or invalid credentials.
        return
    if t is None or not task_access.is_owner(t, c):
        await _accept()
        await websocket.send_json({"t": "err", "d": "这条需求不在这台设备名下，控制台不给开"
                                                    "（里面有工作目录和原始输出）。"})
        await websocket.close(code=4403)          # Reject access to another client's task.
        return
    # Follow the Runner recorded in the task timeline; explicit host is an operational override.
    host = str(host or route_host)
    rn = runner_hub.get(host) if host else None
    if host and rn is None:
        await _accept()
        await websocket.send_json({"t": "err", "d": "那台执行机不在线（%s）" % host})
        await websocket.close()
        return
    if rn is not None:
        async with SessionLocal() as session:
            allowed = await environment_service.task_runner_clients(session, t)
            allowed_orgs = await environment_service.task_runner_orgs(session, t)
        if not runner_hub.in_scope(rn, allowed, allowed_orgs):
            await _accept()
            await websocket.send_json({"t": "err", "d": "这条需求无权使用那台执行机"})
            await websocket.close()
            return
    if rn is None:
        okk, why = _local_support()
        if not okk:
            await _accept()
            await websocket.send_json({"t": "err", "d": why})
            await websocket.close()
            return

    await _accept()
    try:
        async with device_connections.terminal_channel(device, websocket):
            # Revalidate after connection registration to close the concurrent-revocation race.
            async with SessionLocal() as session:
                try:
                    current_client = await device_auth.client_from_transport(
                        session, device, device_session=device_session or "",
                        secret=secret or "", allow_legacy=settings.device_auth_compat,
                    )
                except device_auth.DeviceAuthError:
                    await websocket.send_json({"t": "err", "d": "设备授权已变更，请重新连接。"})
                    await websocket.close(code=4403)
                    return
                current_task = await session.get(Task, task)
            if current_task is None or not task_access.is_owner(current_task, current_client):
                await websocket.send_json({"t": "err", "d": "需求归属已变更，控制台连接已关闭。"})
                await websocket.close(code=4403)
                return
            await _serve_terminal(websocket, task, cols, rows, mode, rn, execution_ref)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        try:
            await websocket.close(code=1011)
        except Exception:  # noqa: BLE001
            pass
