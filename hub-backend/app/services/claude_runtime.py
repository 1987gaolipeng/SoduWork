"""Claude's native binary and SDK adapter share the existing ACP execution path."""
from __future__ import annotations

import os
import shlex
from pathlib import Path

from . import agent_native_install, agent_npm_runtime, agent_npm_network
from . import agent_shell

PACKAGE = "@agentclientprotocol/claude-agent-acp"
VERSION = "0.99.1"


def account_setup(data_root: str, *, windows: bool | None = None) -> dict:
    """Expose a native login command without reading or copying credentials."""
    native = agent_native_install.active_binary(data_root)
    if not native:
        return {}
    home = str(Path(data_root).resolve() / ".claude")
    use_windows = os.name == "nt" if windows is None else windows
    if use_windows:
        quote = lambda value: "'" + value.replace("'", "''") + "'"
        command = f"$env:CLAUDE_CONFIG_DIR={quote(home)}; & {quote(native)} auth login"
        shell = "PowerShell"
    else:
        command = f"CLAUDE_CONFIG_DIR={shlex.quote(home)} {shlex.quote(native)} auth login"
        shell = "Shell"
    return {"command": command, "shell": shell}


def environment(data_root: str, inherited: dict | None = None) -> dict:
    """Use one account and session home per Runner, never an installed client's profile."""
    env = dict(os.environ if inherited is None else inherited)
    home = Path(data_root).resolve() / ".claude"
    home.mkdir(parents=True, exist_ok=True)
    env["CLAUDE_CONFIG_DIR"] = str(home)
    env["DISABLE_AUTOUPDATER"] = "1"
    env["CLAUDE_AGENT_ACP_PROTOCOL"] = "v1"
    for key in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CLAUDECODE"):
        env.pop(key, None)
    native = agent_native_install.active_binary(data_root)
    if native:
        env["CLAUDE_CODE_EXECUTABLE"] = native
    else:
        env.pop("CLAUDE_CODE_EXECUTABLE", None)
    agent_shell.apply(env, "claude")
    return env


def runtime_issue(data_root: str) -> str:
    """Both the native runtime and permission adapter must be available."""
    if not agent_native_install.active_binary(data_root):
        return "Claude Code 执行组件未就绪，请点安装或修复。"
    node = agent_npm_runtime.node_env("claude")
    if not node.get("ok"):
        return str(node.get("why") or "Claude Code 运行环境未就绪，请修复。")
    entry = agent_npm_runtime.package_entry(PACKAGE, "claude-agent-acp")
    if not entry:
        return "Claude Code 权限适配器未就绪，请点安装或修复。"
    return ""


def install_adapter(*, execute, say) -> str:
    """Reuse the Runner's managed Node, npm prefix, network retry and process runner."""
    node = agent_npm_runtime.node_env("claude")
    if not node.get("ok"):
        return str(node.get("why") or "Claude Code 运行环境未就绪，请修复。")
    code, _ = agent_npm_network.run(
        [node["nodePath"], node["npmPath"]],
        ["install", "-g", "--include=optional", "--engine-strict", f"{PACKAGE}@{VERSION}"],
        env=agent_npm_runtime.environment(node, install=True), execute=execute, say=say, timeout=900)
    if code:
        return "Claude Code 权限适配器安装失败，请重试。"
    agent_npm_runtime.activate_environment()
    from .local_base import _data_root
    return runtime_issue(_data_root())
