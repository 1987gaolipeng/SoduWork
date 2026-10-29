"""Bundled Harness² profile; all real tools run through the existing OpenCode ACP gate."""
from __future__ import annotations

import json
import importlib.util
import os
from pathlib import Path
import sys
import tempfile

VERSION = "0.1.0"
MODEL_ENV = "SODUWORK_HARNESS2_MODEL"
ROOT_ENV = "SODUWORK_HARNESS2_ROOT"
EXECUTOR_ENV = "SODUWORK_HARNESS2_EXECUTOR"
CONTINUE_ENV = "SODUWORK_HARNESS2_CONTINUE"
EXECUTOR_PROMPT = """You are the Google Harness² assistant running in SoduWork.
Google Harness² is the user's selected agent harness, not a foundation-model identity.
The underlying model is configured separately by the user or organization. Do not infer
its manufacturer or model family from the harness name, an internal model route, or the
execution component. When asked about your harness, identify Google Harness². When asked
about the underlying model, report only verified information and state uncertainty;
never claim to be a Google/Gemini model merely because this harness was selected.
OpenCode is an execution component used by this harness, not your selected user-facing
identity. Explain that implementation accurately when asked, but do not introduce
yourself as the OpenCode assistant or volunteer internal model routes in ordinary replies.

Complete the user's task with the available tools and their declared schemas. Follow
the current session permissions, approval decisions, workspace scope, and user output
requirements. Read relevant files before editing, preserve unrelated work, and verify
changes with appropriate checks. Report actual results and limitations without claiming
tools ran, files changed, or verification succeeded when they did not.
"""


def version() -> str:
    return VERSION


def is_bundled() -> bool:
    try:
        return all(importlib.util.find_spec(name) is not None for name in (
            "app.services.harness2_engine", "app.services.harness2_vendor.core.recursion",
            "app.services.harness2_vendor.core.tree", "app.services.harness2_vendor.config"))
    except (ImportError, ValueError, AttributeError):
        return False


def runtime_issue(*, probe: bool = False, ignore_disabled: bool = False) -> str:
    if not ignore_disabled:
        from .harness2_lifecycle import disabled_issue
        if issue := disabled_issue():
            return issue
    if not is_bundled():
        return "Google Harness² 内置核心缺失，请更新或修复 SoduWork。"
    from .local_base import _opencode_bin
    executor = _opencode_bin()
    if not executor:
        return "Google Harness² 需要 OpenCode 执行组件，请点「装上」自动准备。"
    from .managed_agents import runtime_issue as executor_issue
    if issue := executor_issue():
        return issue
    if probe:
        from .agent_setup_runtime import _short
        from .agent_version_probe import probe as version_probe
        if not version_probe(executor, ["--version"], run=_short):
            return "Google Harness² 的 OpenCode 执行组件无法启动，请点「装上」修复。"
    return ""


def _args(session: str, mode: str, _ws=None, cfg=None) -> list[str]:
    if isinstance(cfg, dict):
        policy_mode = (cfg.get("accessPolicy") or {}).get("mode")
        if policy_mode in {"standard", "full", "readonly"}:
            mode = "plan" if policy_mode == "readonly" else "work"
        cfg["_soduwork_agent_mode"] = str(mode or "work")
    return ["--session", str(session or ""), "--mode", str(mode or "work")]


def command_argv(exe: str, args: list[str], ws: str, cfg=None) -> list[str]:
    entry = ([exe, "--harness2-bridge"] if getattr(sys, "frozen", False)
             else [exe, str(Path(__file__).with_name("harness2_bridge.py"))])
    argv = [*entry, "--cwd", os.path.abspath(ws), *args]
    if "terminal" in ((cfg or {}).get("requiredCapabilities") or []):
        argv.append("--terminal")
    return argv


def profile() -> dict:
    return {
        "name": "Google Harness²", "bin": lambda: sys.executable,
        "needs_llm": True, "own_session": False,
        "start": lambda sid, mode, ws, cfg=None: _args("", mode, ws, cfg),
        "resume": lambda sid, mode, ws, cfg=None: _args(sid, mode, ws, cfg),
        "command": command_argv, "session_flag": None, "compact": None,
        "argv_prefix": lambda: (["--harness2-bridge"] if getattr(sys, "frozen", False)
                                else [str(Path(__file__).with_name("harness2_bridge.py"))]),
        "runtime_issue": runtime_issue, "runtime_probe": lambda: runtime_issue(probe=True),
    }


def prepare_executor_config(env: dict) -> None:
    """Keep managed model config separate from personal OpenCode config.

    Native data/database/session locations, the injected model and permission
    hook remain as supplied. The selected harness owns the build-agent prompt.
    """
    from .local_base import _data_root
    from .opencode_runtime_config import prepare_environment

    runner_root = Path(_data_root())
    # Runtime secret mappings must not redirect host lifecycle state.
    env["SODUWORK_DATA_ROOT"] = str(runner_root)
    prepare_environment(env, str(runner_root))
    config = json.loads(env.get("OPENCODE_CONFIG_CONTENT") or "{}")
    agents = dict(config.get("agent") or {})
    agents["build"] = {**dict(agents.get("build") or {}), "prompt": EXECUTOR_PROMPT}
    config["agent"] = agents
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config, ensure_ascii=False)


def environment(env: dict, cfg: dict, runtime_ref: str = "") -> dict:
    """Reuse the exact executor model configuration, with a private host-only copy."""
    from .harness2_lifecycle import disabled_issue
    if issue := disabled_issue():
        raise RuntimeError(issue)
    from .local_base import _env_for, _PROFILES, _opencode_bin, _store_dir
    llm = dict(cfg.get("llm") or {})
    if not all(str(llm.get(key) or "").strip() for key in ("base", "key", "model")):
        raise RuntimeError("Google Harness² 没有可用模型，请先配置或授权模型。")
    if (llm.get("kind") or "openai-compat") not in {"openai", "openai-compat", "anthropic"}:
        raise RuntimeError("Google Harness² 当前支持 OpenAI 兼容或 Anthropic 模型接口。")
    result = _env_for(_PROFILES["opencode"], cfg, runtime_ref=runtime_ref)
    result.pop(CONTINUE_ENV, None)
    # A permission change restarts the native ACP session with a 20s handshake
    # deadline. Keep the already-selected harness in that session's history;
    # seven fresh model calls here would time out the permission transition.
    from .local_base import _LOCK, _RUNS
    with _LOCK:
        transition = (_RUNS.get(runtime_ref) or {}).get("_accessTransition") or {}
        if (transition.get("phase") == "applying"
                and (transition.get("targetPolicy") or {}).get("policyHash")
                == (cfg.get("accessPolicy") or {}).get("policyHash")):
            result[CONTINUE_ENV] = "1"
    # Internal generated evidence belongs to the already isolated Runner archive.
    # The existing Runner owns native session identity, continuation and history.
    root = (Path(_store_dir(runtime_ref)) / "harness2" if runtime_ref
            else Path(tempfile.gettempdir()) / "soduwork-harness2-probes")
    result[MODEL_ENV] = json.dumps(llm, ensure_ascii=False)
    result[ROOT_ENV] = str(root)
    result[EXECUTOR_ENV] = _opencode_bin() or ""
    prepare_executor_config(result)
    return result
