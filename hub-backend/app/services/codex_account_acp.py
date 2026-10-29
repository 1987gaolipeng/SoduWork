"""Account Codex permissions through the official ACP bridge.

New versioned-policy sessions use ACP; legacy exec journals retain their native
transport. The transport marker belongs to a saved execution, not user input.
"""
from __future__ import annotations

import json
import os

TRANSPORT_KEY = "_codexTransport"
TRANSPORT = "account-acp-v1"
PACKAGE = "@agentclientprotocol/codex-acp"
LEGACY_MESSAGE = ("这条 Codex 历史会话使用旧版权限通道。请先切换到其他 Agent，"
                  "再切回 Codex，以保留对话并启用新版权限。")


def adapter_bin() -> str:
    from . import acp_agents
    return acp_agents.find_bin("codex-harness") or ""


def runtime_issue() -> str:
    if not adapter_bin():
        return ("Codex 缺少安全权限适配器，请在 Agent 管理中更新 Codex 后重试。"
                "个人账号和企业 Codex Harness 的模型配置保持独立。")
    from . import agent_npm_runtime
    issue = agent_npm_runtime.node_env("codex-harness")
    return str((issue or {}).get("why") or "")


def start_args(sid: str, mode: str, ws: str | None, cfg: dict | None) -> list:
    from . import acp_agents, local_base
    if cfg and cfg.get("accessPolicy"):
        cfg[TRANSPORT_KEY] = TRANSPORT
        return acp_agents.run_args("", mode, ws, cfg)
    if cfg is not None:
        cfg[TRANSPORT_KEY] = ""
    return ["exec", *local_base._codex_args(sid, mode, ws, cfg)]


def resume_args(sid: str, mode: str, ws: str | None, cfg: dict | None) -> list:
    from . import acp_agents, local_base
    cfg = cfg or {}
    if cfg.get(TRANSPORT_KEY) == TRANSPORT:
        if not cfg.get("accessPolicy"):
            raise ValueError("Codex 权限信息缺失，请重新确认本轮权限")
        return acp_agents.run_args(sid, mode, ws, cfg)
    if cfg.get("accessPolicy"):
        raise ValueError(LEGACY_MESSAGE)
    return ["exec", "resume", sid, *local_base._codex_args(sid, mode, None, cfg, resume=True)]


def command_argv(exe: str, args: list, ws: str, cfg: dict) -> list:
    if cfg.get(TRANSPORT_KEY) != TRANSPORT:
        if cfg.get("accessPolicy"):
            raise ValueError(LEGACY_MESSAGE)
        return [exe, *args]
    if not cfg.get("accessPolicy") or "--soduwork-session" not in args:
        raise ValueError("Codex 权限通道与会话启动参数不一致")
    issue = runtime_issue()
    if issue:
        raise RuntimeError(issue)
    from . import acp_agents
    return acp_agents.command_argv("codex", adapter_bin(), args, ws, cfg)


def prepare_env(env: dict, cfg: dict, native_bin: str) -> None:
    from . import codex_account_home, local_base
    private_account = os.path.normcase(os.path.abspath(str(env.get("CODEX_HOME") or ""))) == \
        os.path.normcase(codex_account_home.account_home(local_base._data_root()))
    if private_account:
        # Account ownership applies to native exec as well as ACP, after plugin
        # environment mappings have been resolved by the host.
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
                    "DEFAULT_AUTH_REQUEST", "CODEX_CONFIG", "MODEL_PROVIDER",
                    "OPENAI_BASE_URL", "OPENAI_MODEL", "SODUWORK_LLM_KEY"):
            env.pop(key, None)
        env["CODEX_SQLITE_HOME"] = env["CODEX_HOME"]
    if cfg.get(TRANSPORT_KEY) != TRANSPORT:
        return
    if not native_bin:
        raise RuntimeError("Codex 官方执行程序不可用，请在 Agent 管理中更新 Codex")
    # This adapter must never inherit the enterprise Harness gateway or secrets
    # contributed by plugin runtime env mappings. Only the original personal
    # OPENAI_API_KEY (if configured) and isolated auth.json may authenticate it.
    for key in ("DEFAULT_AUTH_REQUEST", "CODEX_CONFIG", "MODEL_PROVIDER", "INITIAL_AGENT_MODE",
                "OPENAI_BASE_URL", "OPENAI_MODEL", "SODUWORK_LLM_KEY", "OPENAI_API_KEY"):
        env.pop(key, None)
    if not private_account and os.environ.get("OPENAI_API_KEY"):
        env["OPENAI_API_KEY"] = os.environ["OPENAI_API_KEY"]
    config = {"disable_response_storage": True}
    model = str(cfg.get("codex_model") or "").strip()
    effort = str(cfg.get("codex_reasoning_effort") or "").strip()
    if model or effort:
        from . import agent_execution_options
        options = agent_execution_options.runtime_options("local:codex", model, effort)
        if options.get("model"):
            config["model"] = options["model"]
        if options.get("reasoningEffort"):
            config["model_reasoning_effort"] = options["reasoningEffort"]
    env.update(CODEX_PATH=native_bin, NO_BROWSER="1", INITIAL_AGENT_MODE="read-only",
               CODEX_CONFIG=json.dumps(config, ensure_ascii=False, separators=(",", ":")))


def retained_config(run: dict) -> dict:
    """Non-secret transport identity survives per-turn credential scrubbing."""
    if run.get("cli") != "codex" or run.get("_executionStart"):
        return {}
    marker = (run.get("cfg") or {}).get(TRANSPORT_KEY, run.get("codexTransport"))
    return {TRANSPORT_KEY: TRANSPORT} if marker == TRANSPORT else {}


def legacy_policy_issue(run: dict, value) -> str:
    if (run.get("cli") == "codex" and value and run.get("cliSid")
            and not run.get("_executionStart")
            and retained_config(run).get(TRANSPORT_KEY) != TRANSPORT):
        return LEGACY_MESSAGE
    return ""
