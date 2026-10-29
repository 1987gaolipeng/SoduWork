"""Explicit setup of the bundled Harness² core's shared execution dependency."""
from __future__ import annotations

from threading import RLock

from . import harness2_lifecycle, harness2_runtime, managed_agents

_ACTION_LOCK = RLock()


def _check_versions() -> str:
    current = managed_agents.binary_version(managed_agents.opencode_binary())
    target = managed_agents.OPENCODE_VERSION
    if not current:
        executor = "受管 OpenCode 执行组件尚未安装；SoduWork 支持的版本为 " + target + "。"
    elif current == target:
        executor = "OpenCode 执行组件 " + current + "，已是 SoduWork 支持的版本，无需更新。"
    else:
        executor = ("OpenCode 执行组件当前为 " + current + "；SoduWork 支持的版本为 "
                    + target + "，需要更新。")
    return ("Harness² 核心 " + harness2_runtime.version() + "（随 SoduWork 升级）。"
            + executor + harness2_lifecycle.disabled_issue())


def run(jid: str, action: str) -> None:
    # Import the job helpers only after agent_setup has initialized its registry.
    from .agent_setup import _done, _say

    try:
        with _ACTION_LOCK:
            if action == "uninstall":
                harness2_lifecycle.disable()
                _done(jid, True, "Google Harness² 已卸载；内置核心及共享 OpenCode 执行组件已保留，点「装上」可重新启用。")
                return
            if not harness2_runtime.is_bundled():
                _done(jid, False, "Harness² 内置文件不完整，请修复或升级 SoduWork。")
                return
            if action == "check":
                _done(jid, True, _check_versions())
                return
            ok, detail = managed_agents.install(action, lambda line: _say(jid, line))
            if not ok:
                _done(jid, False, detail)
                return
            issue = harness2_runtime.runtime_issue(probe=True, ignore_disabled=True)
            if issue:
                _done(jid, False, issue)
                return
            harness2_lifecycle.enable()
            _done(jid, True, "Google Harness² 内置核心及执行组件已就绪；点「测一下」确认模型连接。")
    except Exception as exc:  # noqa: BLE001 - always settle the setup job
        _done(jid, False, "Harness² 操作未完成：" + str(exc)[:220])
