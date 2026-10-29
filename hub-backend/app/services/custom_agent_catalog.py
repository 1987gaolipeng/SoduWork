"""Additive, desktop-owned ACP declarations; never a network plugin loader.

The desktop persists declarations. This process only validates and activates
them after its private parent pipe supplies them. Existing profiles and live
sessions retain their identities; replacement/removal needs a separate design.
"""
from __future__ import annotations

import copy
import hashlib
import json
import ntpath
import os
import re
import sys
import threading

from .. import agent_catalog

MAX_AGENTS = 16
MAX_BYTES = 32 * 1024
_BUILTINS = frozenset(agent_catalog.AGENTS)
_CUSTOM: dict[str, dict] = {}
_LOCK = threading.RLock()
_SHELLS = {"cmd", "powershell", "pwsh", "bash", "sh", "zsh", "fish",
           "wscript", "cscript", "mshta"}
_PROCESS_ENV = {"PATH", "PATHEXT", "COMSPEC", "NODE_OPTIONS", "NODE_PATH",
                "PYTHONHOME", "PYTHONPATH", "LD_PRELOAD", "LD_LIBRARY_PATH"}
_FIELDS = {"id", "displayName", "summary", "transport", "modelMode", "goalMode",
           "group", "order", "accessControl", "runner", "install"}


def _text(value, name: str, limit: int, *, empty: bool = False) -> str:
    if (not isinstance(value, str) or len(value) > limit or
            any(ord(c) < 32 or ord(c) == 127 for c in value) or
            (not empty and not value.strip())):
        raise ValueError(f"Invalid custom Agent {name}")
    return value


def validate(agents) -> dict[str, dict]:
    """Validate the whole batch first; no filesystem/process side effects."""
    if not isinstance(agents, list) or len(agents) > MAX_AGENTS:
        raise ValueError("Custom Agent list exceeds its limit")
    try:
        raw = json.dumps(agents, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ValueError("Invalid custom Agent document") from exc
    if len(raw) > MAX_BYTES:
        raise ValueError("Custom Agent document exceeds 32 KB")
    if not agents:
        return {}
    rows = copy.deepcopy(agents)
    for row in rows:
        if not isinstance(row, dict) or set(row) - _FIELDS:
            raise ValueError("Unsupported custom Agent declaration fields")
        key = _text(row.get("id"), "id", 40)
        if not re.fullmatch(r"custom-[a-z0-9][a-z0-9-]{0,32}", key):
            raise ValueError("Custom Agent id must start with custom-")
        if key in _BUILTINS:
            raise ValueError("Built-in Agents cannot be replaced")
        _text(row.get("displayName"), "name", 80)
        _text(row.get("summary", ""), "summary", 400, empty=True)
        if (row.get("transport") != "runner" or row.get("goalMode") != "none" or
                row.get("group") not in {"recommended", "more"} or
                type(row.get("order")) is not int or not 0 <= row["order"] <= 10000):
            raise ValueError("Custom Agent must use the standard ACP conversation runtime")
        if row.get("accessControl") != {
                "schema": "soduwork.access-policy/v1", "supported": False, "modes": [],
                "approval": "", "sandbox": False}:
            raise ValueError("Custom Agents cannot declare unverified permissions")
        if any(type(row["accessControl"].get(key)) is not bool for key in ("supported", "sandbox")):
            raise ValueError("Invalid custom Agent permission declarations")
        runner = row.get("runner")
        if (not isinstance(runner, dict) or
                set(runner) - {"adapter", "bins", "args", "home", "modelEnv"} or
                runner.get("adapter") != "acp"):
            raise ValueError("Custom Agent requires the standard ACP adapter")
        bins = runner.get("bins")
        if not isinstance(bins, list) or len(bins) != 1:
            raise ValueError("Custom Agent requires exactly one executable")
        executable = _text(bins[0], "executable", 2048)
        if not (os.path.isabs(executable) or ntpath.isabs(executable) or
                re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", executable)):
            raise ValueError("Use an absolute executable path or a PATH command name")
        basename = ntpath.basename(executable).lower()
        if basename.rsplit(".", 1)[0] in _SHELLS or basename in _SHELLS:
            raise ValueError("Configure the ACP executable directly, not a shell")
        args = runner.get("args")
        if not isinstance(args, list) or len(args) > 32:
            raise ValueError("Custom Agent arguments must be an array of at most 32 items")
        for value in args:
            _text(value, "argument", 2048, empty=True)
            token = value.lower()
            if (token in {"-e", "-c", "/c", "/k", "--eval", "--command", "-command",
                          "-encodedcommand", "--encodedcommand"} or
                    token.startswith(("--eval=", "--command=", "-encodedcommand=", "--encodedcommand="))):
                raise ValueError("Inline code and shell commands are not ACP arguments")
        home = runner.get("home", {})
        model_env = runner.get("modelEnv", {})
        if (not isinstance(home, dict) or set(home) - {"env", "folder"} or
                not isinstance(model_env, dict)):
            raise ValueError("Invalid custom Agent environment declarations")
        for name in [*model_env, *([home.get("env")] if home else [])]:
            if not isinstance(name, str) or name in _PROCESS_ENV or name.startswith(("SODUWORK_", "SODUWORK_", "DYLD_")):
                raise ValueError("Custom Agent cannot replace process control environment")
        if home and home.get("folder") != "." + key:
            raise ValueError("Custom Agent home must use its isolated identity directory")
        install = row.get("install")
        if (not isinstance(install, dict) or
                set(install) - {"installer", "source", "blurb", "config_how", "config_path", "install_how"} or
                install.get("installer") != "manual"):
            raise ValueError("Custom Agent registration cannot install software")
        for name, value in install.items():
            _text(value, "installation metadata", 400, empty=True)
        if row.get("modelMode") == "account" and runner.get("modelEnv"):
            raise ValueError("Account Agents cannot receive shared model credentials")
    return agent_catalog.validate_catalog({"schemaVersion": 1, "agents": rows})


def _public(row: dict) -> dict:
    return {key: copy.deepcopy(row[key]) for key in _FIELDS - {"runner", "install"}
            if key in row}


def apply(agents) -> dict:
    """Activate additions synchronously; invalid batches leave every cache intact."""
    incoming = validate(agents)
    with _LOCK:
        if len(set(_CUSTOM) | set(incoming)) > MAX_AGENTS:
            raise ValueError("At most 16 custom Agents can be registered")
        for key, row in incoming.items():
            if key in _CUSTOM and row != _CUSTOM[key]:
                raise ValueError("Registered custom Agents cannot be edited; add a new Agent")
        combined = {**_CUSTOM, **incoming}
        if len(json.dumps(list(combined.values()), ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_BYTES:
            raise ValueError("Custom Agent document exceeds 32 KB")
        additions = {key: row for key, row in incoming.items() if key not in _CUSTOM}
        # Imports happen before publishing anything. Existing sessions keep the
        # exact same profile object, closures, run history and access policy.
        from . import acp_agents, agent_execution_options, agent_naming, agent_setup, local_base
        specs = {key: {
            **row["install"], **row["runner"], "name": row["displayName"],
            "acp": tuple(row["runner"]["args"]), "bins": tuple(row["runner"]["bins"]),
            "needs_llm": row["modelMode"] == "managed",
        } for key, row in additions.items()}
        profiles = {key: acp_agents.profile(key, spec) for key, spec in specs.items()}
        # No await or executable discovery in this publication block. Publish
        # the directory last, once every execution consumer knows the new ID.
        acp_agents.CATALOG.update(specs)
        local_base._PROFILES.update(profiles)
        agent_setup._SPECS.update({key: dict(row["install"]) for key, row in additions.items()})
        agent_execution_options.GATEWAY_MODEL_KINDS.update(
            "local:" + key for key, row in additions.items() if row["modelMode"] == "managed")
        for key, row in additions.items():
            for label in (key, row["displayName"]):
                alias = label.lower().replace(" ", "").replace("_", "")
                agent_naming._CLI_ALIAS.setdefault(alias, key)
            agent_naming._CLI_BY_LABEL[key] = key
        options = sys.modules.get("app.services.task_execution_options")
        if options:
            options._CLI_ORDER.update({key: row["order"] for key, row in additions.items()})
            options._CLI_LABELS.update({key: row["displayName"] for key, row in additions.items()})
        agent_catalog.AGENTS.update(additions)
        _CUSTOM.update(additions)
        revision = hashlib.sha256(json.dumps(
            _CUSTOM, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")).hexdigest()
        return {"agents": [_public(row) for row in _CUSTOM.values()],
                "added": list(additions), "revision": revision}


def restore(config: dict, *, desktop_owned: bool) -> None:
    """Only the private desktop startup frame may supply executable declarations."""
    if "customAgents" not in config:
        return
    # The desktop always includes this field in its startup frame.  An empty
    # list means that no custom Agents are registered; importing the execution
    # catalog in that case needlessly pulls Hub-only services into the slim
    # standalone Runner (which intentionally has no SQLAlchemy dependency).
    if config.get("customAgents") == []:
        return
    if not desktop_owned:
        raise ValueError("Custom Agents require the private desktop startup channel")
    apply(config["customAgents"])
