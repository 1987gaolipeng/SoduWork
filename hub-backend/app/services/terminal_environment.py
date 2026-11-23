"""Construct terminal environments on the machine that owns the execution.

The terminal RPC carries session metadata only. In particular, neither legacy
``env`` nor arbitrary configuration from a Hub is applied to the Runner process.
Task credentials may only come from the configuration already held for that
task's dispatched execution; host paths and OS variables always stay local.
"""
from __future__ import annotations


def runner_environment(task: str, ref: str, cli: str, work_root: str = "", mode: str = "session") -> dict:
    from . import local_base, runtime_images

    if cli == "opencode" and mode == "session" and ref:
        with local_base._LOCK:
            missing = ref not in local_base._RUNS
        if missing:
            local_base.rehydrate(ref)
    with local_base._LOCK:
        run = dict(local_base._RUNS.get(ref) or {}) if ref else {}
        if run and str(run.get("taskId") or "") != task:
            raise ValueError("终端会话不属于这条需求")
        cfg = dict(run.get("cfg") or {})

    actual_cli = str(run.get("cli") or cli or "")
    if cli and actual_cli != cli:
        raise ValueError("终端底座与原执行会话不一致")
    prof = local_base._PROFILES.get(actual_cli)

    # No execution (or a recovered archive without in-memory credentials): use
    # the Runner's own shell/login environment. Never borrow Hub global model
    # credentials or a different task's configuration to fill that gap.
    if not cfg:
        # Native launchers still need their local setup (notably bundled Pi's
        # Electron-as-Node flag and Codex home). ACP model injection requires
        # managed credentials, so leave its shell/login environment untouched.
        native = prof if prof and not prof.get("acp_key") else {}
        env = local_base._env_for(native, {"local_workspace_root": work_root},
                                  runtime_ref=ref, require_model=False)
    else:
        if prof is None:
            raise ValueError("原执行会话的底座不可用")
        cfg.pop(runtime_images.CFG_KEY, None)
        # Resolve task credentials only from this execution host's environment.
        env = local_base._env_for(prof, cfg, runtime_ref=ref)

    if actual_cli == "opencode":
        prepare_opencode_environment(env, run, prof, mode)
    return env


def prepare_opencode_environment(env: dict, run: dict, prof: dict | None, mode: str) -> None:
    """Bind a terminal to a locally owned execution already authorized by its caller."""
    from . import local_base, opencode_runtime_config, opencode_session_migration
    opencode_runtime_config.prepare_environment(env, local_base._data_root())
    # A plain shell remains available when native session recovery is blocked.
    if mode == "session" and run.get("cliSid"):
        executable = prof and prof["bin"]()
        if not executable:
            raise RuntimeError("OpenCode 执行组件不可用，请先修复组件再连接原会话")
        opencode_session_migration.migrate_session(
            env, run["cliSid"], str(run.get("ws") or ""), executable)
