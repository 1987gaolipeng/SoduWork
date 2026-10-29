"""Noninteractive Runner deployment using isolated worktrees, persistent state, health checks, and
rollback.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time

from . import http_assertions

_LOCK = threading.RLock()
_ACTIVE: set[str] = set()
_REDACT: dict[str, list[str]] = {}
_REV: dict[str, int] = {}
_MAX_LOG = 1024 * 1024


def _data_root() -> str:
    from .local_base import _data_root as root
    path = os.path.join(root(), "deployments")
    os.makedirs(path, exist_ok=True)
    return path


def _state_path(run_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9-]{6,80}", str(run_id or "")):
        raise ValueError("部署运行号不合法")
    return os.path.join(_data_root(), run_id + ".json")


def _log_path(run_id: str) -> str:
    return os.path.join(_data_root(), run_id + ".log")


def _save(state: dict) -> None:
    path = _state_path(state["id"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    with _LOCK:
        run_id = str(state["id"])
        _REV[run_id] = int(_REV.get(run_id) or 0) + 1


def _load(run_id: str) -> dict | None:
    for attempt in range(4):
        try:
            with open(_state_path(run_id), encoding="utf-8") as f:
                return json.load(f)
        except PermissionError:
            # Windows antivirus or indexing may briefly lock a newly replaced file.
            if attempt < 3:
                time.sleep(0.01)
                continue
            return None
        except (FileNotFoundError, ValueError, json.JSONDecodeError, OSError):
            return None
    return None


def _redact(run_id: str, text) -> str:
    line = str(text or "")
    with _LOCK:
        secrets = list(_REDACT.get(run_id) or [])
    for value in secrets:
        if value:
            line = line.replace(value, "***")
    return line


def _append(run_id: str, text: str) -> None:
    line = _redact(run_id, text)
    with open(_log_path(run_id), "a", encoding="utf-8", errors="replace") as f:
        f.write(line)
        if line and not line.endswith("\n"):
            f.write("\n")
    try:
        path = _log_path(run_id)
        if os.path.getsize(path) > _MAX_LOG * 2:
            with open(path, "rb") as f:
                f.seek(-_MAX_LOG, os.SEEK_END)
                tail = f.read()
            with open(path, "wb") as f:
                f.write(tail)
    except OSError:
        pass


def _apply_subs(text: str, subs: dict) -> str:
    for key, value in subs.items():
        if key in text:
            if not value:
                raise ValueError(f"部署命令里用了 {key}，但这次部署没有对应的值")
            text = text.replace(key, value)
    return text


def _argv(value, name: str, spec: dict | None = None) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > 80:
        raise ValueError(f"{name}必须是非空参数数组")
    out = [str(x or "")[:500] for x in value]
    if any(not x for x in out):
        raise ValueError(f"{name}含空参数")
    # Deployment scripts need the selected version and environment even though argv is static.
    # shell=False does not expand variables, so replace supported placeholders explicitly.
    # Accept only controlled tokens whose values come from the deployment run.
    data = dict(spec or {})
    subs = {"{commit}": str(data.get("commit") or ""),
            "{env}": str(data.get("environmentKey") or "")}
    return [_apply_subs(x, subs) for x in out]


def _safe_seg(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(value or ""))[:80] or "x"


def _deploy_dir(work_root: str, spec: dict) -> str:
    if not str(work_root or "").strip():
        raise ValueError("这台执行机还没设置工作目录")
    root = os.path.realpath(os.path.abspath(os.path.expanduser(work_root)))
    target = os.path.realpath(os.path.join(
        root, ".soduwork-deploy", _safe_seg(spec.get("repoId")), _safe_seg(spec.get("environmentKey"))))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("部署目录越过了工作根目录")
    return target


def _run(argv: list[str], cwd: str, env: dict, timeout: int, run_id: str, label: str) -> tuple[int, str]:
    _append(run_id, f"\n[{label}] $ " + " ".join(argv))
    try:
        proc = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding="utf-8", errors="replace", timeout=timeout,
                              shell=False)
        out = proc.stdout or ""
        _append(run_id, out)
        return proc.returncode, _redact(run_id, out[-4000:])
    except subprocess.TimeoutExpired as e:
        out = str(e.stdout or "")
        _append(run_id, out + f"\n{label}超时（>{timeout}s）")
        return 124, _redact(run_id, out[-4000:])
    except Exception as e:  # noqa: BLE001
        msg = f"{label}起不来（{type(e).__name__}: {str(e)[:180]}）"
        _append(run_id, msg)
        return 127, _redact(run_id, msg)


def _git(argv: list[str], cwd: str | None, env: dict, run_id: str) -> None:
    code, tail = _run(["git", "-c", "http.proxy=", "-c", "https.proxy=", *argv],
                      cwd or os.getcwd(), env, 600, run_id, "准备代码")
    if code:
        raise RuntimeError(tail or "Git 操作失败")


def _sync_origin(path: str, url: str, env: dict, run_id: str) -> None:
    """Keep a persistent deployment worktree bound to the configured repository.

    Worktrees survive runs so deployment state can be reused, while a project
    repository URL can change (for example from a local mirror to GitLab). A
    fetch alone keeps the old origin forever and can make a valid commit look
    missing. Reconcile origin before every fetch.
    """
    code, current = _run(
        ["git", "remote", "get-url", "origin"], path, env, 30, run_id,
        "check repository origin",
    )
    if code:
        _git(["remote", "add", "origin", url], path, env, run_id)
        return
    if current.strip().rstrip("/") != str(url).strip().rstrip("/"):
        _git(["remote", "set-url", "origin", url], path, env, run_id)


def _prepare(spec: dict, work_root: str, env: dict, run_id: str) -> str:
    path = _deploy_dir(work_root, spec)
    url, branch = str(spec.get("gitUrl") or ""), str(spec.get("branch") or "main")
    if not url:
        raise ValueError("部署目标所属仓库没有 Git 地址")
    if os.path.isdir(os.path.join(path, ".git")):
        _sync_origin(path, url, env, run_id)
        _git(["fetch", "--all", "--prune"], path, env, run_id)
    elif os.path.isdir(path) and os.listdir(path):
        raise ValueError("专用部署目录已存在但不是 Git 仓库")
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _git(["clone", "--branch", branch, url, path], os.path.dirname(path), env, run_id)
    # Use a dedicated deployment worktree pinned to the reviewed version, separate from user development files.
    want = str(spec.get("commit") or "")
    if want:
        # Pin the approved commit itself, not the current branch tip.
        # The branch may advance while review or builds are pending.
        # Detached checkout ensures the deployed content is exactly the reviewed revision.
        _git(["checkout", "--detach", want], path, env, run_id)
        _git(["reset", "--hard", want], path, env, run_id)
        code, got = _run(["git", "rev-parse", "HEAD"], path, env, 30, run_id, "核对版本")
        if code or not got.strip().lower().startswith(want.lower()):
            raise RuntimeError("部署工作树不是获批的合并版本")
    else:
        _git(["checkout", "-B", branch, f"origin/{branch}"], path, env, run_id)
        _git(["reset", "--hard", f"origin/{branch}"], path, env, run_id)
    return path


def _check(item: dict, cwd: str, env: dict, run_id: str,
           variables: dict | None = None) -> tuple[bool, str]:
    item = http_assertions.materialize(item, variables)
    kind, name = str(item.get("type") or ""), str(item.get("name") or "健康检查")
    timeout = min(120, max(1, int(item.get("timeoutSeconds") or 15)))
    if kind == "command":
        code, tail = _run(_argv(item.get("argv"), "检查命令"), cwd, env, timeout, run_id, name)
        return code == 0, tail
    if kind == "http":
        method, url = str(item.get("method") or "GET").upper(), str(item.get("url") or "")
        _append(run_id, f"\n[{name}] {method} {url}")
        result = http_assertions.probe(item)
        detail = _redact(run_id, result.get("detail") or "")
        _append(run_id, detail)
        return bool(result.get("ok")), detail
    if kind == "screenshot":
        # Hub captures deployment screenshots when the Runner has no browser.
        # Allow the declaration here; deployments._capture_receipt adds actual evidence later.
        # Do not claim execution or reject the whole run for this delegated check.
        # Other successful health checks remain valid evidence.
        _append(run_id, f"\n[{name}] 截图由 Hub 侧在部署成功后抓取，此处不执行")
        return True, "由 Hub 侧抓取（deploy_screenshot）"
    return False, "不支持的健康检查"


def _worker(spec: dict, work_root: str, secret_values: list[str]) -> None:
    run_id = spec["runId"]
    secret_values.extend(
        str(value) for value in list(spec.get("redact") or [])
        if str(value or ""))
    with _LOCK:
        _REDACT[run_id] = list(secret_values)

    state = _load(run_id) or {"id": run_id}
    # Record the actual failure stage for server-side classification.
    # prepare failures are infrastructure problems and must not trigger code rework.
    # deploy and check failures follow the plugin's configured recovery policy.
    state.update(state="running", startedAt=int(time.time() * 1000), error="",
                 result={"checks": [], "checksPlanned": len(spec.get("checks") or [])},
                 stage="prepare")
    _save(state)
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env.update({str(k): str(v) for k, v in dict(spec.get("env") or {}).items()})
    git = dict(spec.get("git") or {})
    try:
        # Keep HTTPS credentials in this RPC's memory; SSH keys use temporary Runner-data files.
        # Delete keys in finally and enable log redaction before cloning.
        secret_values.extend(str(git.get(key) or "") for key in ("token", "key")
                             if str(git.get(key) or ""))
        for item in spec.get("secrets") or []:
            if item.get("provider") != "runner-env":
                raise ValueError("首版只支持执行机环境变量型密钥引用")
            source = str(item.get("locator") or "")
            value = os.environ.get(source)
            if value is None:
                raise ValueError(f"执行机缺少密钥环境变量 {source}")
            env[str(item.get("env") or source)] = value
            secret_values.append(value)
        with _LOCK:
            _REDACT[run_id] = list(secret_values)
        if git:
            from . import code_creds
            code_creds.env_for(env, git, ref=run_id)
        cwd = _prepare(spec, work_root, env, run_id)
        argv = _argv(spec.get("argv"), "部署命令", spec)
        state["stage"] = "deploy"
        _save(state)
        code, tail = _run(argv, cwd, env, min(3600, max(10, int(spec.get("timeoutSeconds") or 900))),
                          run_id, "部署")
        if code:
            raise RuntimeError(tail or f"部署退出码 {code}")
        state["stage"] = "check"
        checks = []
        commit = str(spec.get("commit") or "")
        check_variables = {
            "DEPLOY_COMMIT": commit,
            "DEPLOY_COMMIT_SHORT": commit[:12],
        }
        for item in spec.get("checks") or []:
            passed, detail = _check(
                dict(item), cwd, env, run_id, check_variables)
            checks.append({"name": item.get("name") or "健康检查", "ok": passed,
                           "type": item.get("type") or "http", "detail": detail})
            # Persist each completed check so later failures or restarts cannot erase collected evidence.
            state["result"] = {"checks": list(checks),
                               "checksPlanned": len(spec.get("checks") or []),
                               "workDir": cwd}
            _save(state)
            if not passed:
                raise RuntimeError(detail)
        state.update(state="succeeded", result={"checks": checks,
                                                "checksPlanned": len(spec.get("checks") or []),
                                                "workDir": cwd})
    except Exception as e:  # noqa: BLE001
        state["error"] = _redact(run_id, e)[:1000]
        rollback = dict(spec.get("rollback") or {})
        argv = rollback.get("argv")
        # Preparation has not changed the environment; rollback is permitted only after deployment commands start.
        # A Git or credential failure must not activate an older historical rollback target.
        deployment_started = state.get("stage") in {"deploy", "check"}
        if deployment_started and rollback.get("mode") == "automatic" and argv:
            try:
                cwd = locals().get("cwd") or _deploy_dir(work_root, spec)
                code, tail = _run(_argv(argv, "回滚命令", spec), cwd, env, 900, run_id, "自动回滚")
                state["state"] = "rolled_back" if code == 0 else "rollback_failed"
                state["result"] = {**dict(state.get("result") or {}),
                                   "rollback": {"ok": code == 0, "detail": tail}}
            except Exception as rollback_error:  # noqa: BLE001
                state["state"] = "rollback_failed"
                state["result"] = {**dict(state.get("result") or {}),
                                   "rollback": {"ok": False,
                                                "detail": _redact(run_id, rollback_error)[:500]}}
        else:
            state["state"] = "failed"
    finally:
        state["finishedAt"] = int(time.time() * 1000)
        _save(state)
        with _LOCK:
            _ACTIVE.discard(run_id)
            _REDACT.pop(run_id, None)
        if git.get("key"):
            try:
                from . import code_creds
                code_creds.forget_key(run_id)
            except Exception:  # noqa: BLE001
                pass
        secret_values.clear()


def start(spec: dict, work_root: str) -> dict:
    run_id = str(spec.get("runId") or "")
    _state_path(run_id)  # validate before touching the active set
    with _LOCK:
        old = _load(run_id)
        if old is not None:
            return status(run_id)
        if run_id in _ACTIVE:
            return {"ok": True, "state": "running", "id": run_id}
        state = {"id": run_id, "state": "queued", "createdAt": int(time.time() * 1000),
                 "startedAt": None, "finishedAt": None, "error": "", "result": {}}
        _save(state)
        _ACTIVE.add(run_id)
    secrets: list[str] = []
    threading.Thread(target=_worker, args=(dict(spec), work_root, secrets),
                     name="deploy-" + run_id[:8], daemon=True).start()
    return {"ok": True, **state}


def preflight(spec: dict, work_root: str) -> dict:
    """Check executor capability and secret availability without fetching code, deploying, or
    returning secret values.
    """
    work_root_set = bool(str(work_root or "").strip())
    secrets = []
    for item in spec.get("secrets") or []:
        locator = str(item.get("locator") or "")
        present = bool(locator and os.environ.get(locator) is not None)
        secrets.append({"env": str(item.get("env") or locator),
                        "locator": locator, "present": present})
    argv = spec.get("argv") or []
    command = str(argv[0] if isinstance(argv, list) and argv else "")
    if not command:
        command_state = "not_required"
    elif os.path.isabs(command):
        command_state = "available" if os.path.isfile(command) else "missing"
    elif any(x in command for x in ("/", "\\")):
        command_state = "repository_relative"
    else:
        command_state = "available" if shutil.which(command) else "missing"
    missing = []
    if not work_root_set:
        missing.append("未设置工作根目录")
    if command_state == "missing":
        missing.append("部署命令不可用")
    if any(not x["present"] for x in secrets):
        missing.append("密钥环境变量未就位")
    return {
        "ok": not missing,
        "workRootSet": work_root_set,
        "command": command, "commandState": command_state, "secrets": secrets,
        "error": "；".join(missing),
    }


def status(run_id: str) -> dict:
    state = _load(run_id)
    if state is None:
        return {"ok": False, "error": "没有这次部署运行"}
    tail = ""
    try:
        with open(_log_path(run_id), encoding="utf-8", errors="replace") as f:
            tail = f.read()[-12000:]
    except FileNotFoundError:
        pass
    return {"ok": True, **state, "log": tail}


def snapshots(marks: dict[str, int] | None = None, limit: int = 20) -> tuple[list[dict], list[tuple]]:
    """Read new deployment facts from this process; the caller advances marks only after successful
    delivery.
    """
    seen = dict(marks or {})
    with _LOCK:
        changed = [(run_id, rev) for run_id, rev in _REV.items()
                   if int(rev) > int(seen.get(run_id) or 0)]
    changed.sort(key=lambda item: item[1], reverse=True)
    out, advances = [], []
    for run_id, rev in changed[:max(1, min(50, int(limit or 20)))]:
        item = status(run_id)
        if not item.get("ok"):
            continue
        out.append(item)
        advances.append((run_id, rev))
    return out, advances


def busy() -> int:
    with _LOCK:
        return len(_ACTIVE)
