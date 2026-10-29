"""Versioned access contract for Runner adapters (stdlib only).

Legacy calls have no policy and keep their existing execution path. A historic
``mode=work`` / ``full`` is deliberately not a consent to this new contract.
"""
from __future__ import annotations

import hashlib
import json
import os

from ..agent_catalog import AGENTS

SCHEMA = "soduwork.access-policy/v1"
MODES = {"standard", "full", "readonly"}
ACP_AGENTS = {key for key, row in AGENTS.items()
              if row["accessControl"]["supported"]
              and row["accessControl"].get("approval") == "native-acp"}


class PolicyError(ValueError):
    code = "ACCESS_POLICY_INVALID"


class UnsupportedPolicyError(PolicyError):
    code = "ACCESS_POLICY_UNSUPPORTED"


def normalize(value, workspace: str = "") -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise PolicyError("Unsupported access policy schema")
    mode = value.get("mode")
    revision = value.get("revision")
    if mode not in MODES or type(revision) is not int or revision < 1:
        raise PolicyError("Invalid access policy mode or revision")
    supplied = str(value.get("workspaceRoot") or "").strip()
    if not supplied or not os.path.isabs(supplied):
        raise PolicyError("Access policy requires an absolute workspace root")
    root = os.path.realpath(os.path.abspath(supplied))
    if workspace and os.path.normcase(root) != os.path.normcase(os.path.realpath(workspace)):
        raise PolicyError("Access policy workspace does not match the execution workspace")
    policy = {"schema": SCHEMA, "mode": mode, "revision": revision,
              "workspaceRoot": root}
    # Session identity is assigned by the trusted desktop/Hub route, never by
    # agent output. No arbitrary policy fields become process environment.
    if value.get("sessionId"):
        policy["sessionId"] = str(value["sessionId"])[:160]
    policy["policyHash"] = hashlib.sha256(json.dumps(
        policy, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return policy


def capability(agent: str) -> dict:
    supported = agent in ACP_AGENTS
    return {"schema": SCHEMA, "supported": supported,
            "canChangeDuringSession": supported,
            "changeTakesEffect": "current-turn" if supported else "unsupported",
            "modes": ["standard", "readonly", "full"] if supported else [],
            "approval": "native-acp" if supported else "unsupported",
            "sandbox": False,
            "enforcement": "native-permissions-and-host-tools" if supported else "legacy",
            "limitations": ["No SoduWork operating-system sandbox is provided.",
                            "Native permission support is verified during session initialization."]
            if supported else ["This adapter has not implemented the versioned access contract."]}


def prepare(agent: str, value, workspace: str) -> dict | None:
    policy = normalize(value, workspace)
    if policy and agent not in ACP_AGENTS:
        raise UnsupportedPolicyError("This Agent does not support the requested access contract")
    return policy


def operation_digest(operation: dict) -> str:
    # Preserve every execution input, including unknown fields. Only known
    # command metadata is excluded, never similarly named MCP arguments.
    fields = {key: operation.get(key) for key in
              ("action", "target", "arguments", "locations", "kind", "title", "tool")}
    arguments = fields["arguments"]
    command = (operation.get("action") == "terminal.execute"
               or operation.get("action") == "command.execute" and operation.get("tool") == "bash")
    if command and isinstance(arguments, dict) and isinstance(arguments.get("command"), str):
        fields["title"] = None
        fields["arguments"] = {key: value for key, value in arguments.items()
                               if key not in {"description", "timeout"}}
    if (operation.get("action") == "native.command" and operation.get("tool") == "codex.shell"
            and isinstance(arguments, dict) and isinstance(arguments.get("command"), str)):
        # These fields come from Codex's request envelope, not arbitrary MCP
        # inputs. A new call/turn ID or explanation is not a different command.
        fields["title"] = None
        fields["arguments"] = {key: value for key, value in arguments.items()
                               if key not in {"threadId", "turnId", "itemId", "reason"}}
    if (operation.get("action") == "native.command" and operation.get("tool") in {"opencode.shell", "qwen.shell"}
            and isinstance(arguments, dict) and isinstance(arguments.get("command"), str)):
        # Verified native ACP shell tools use description/title only for the
        # display label. Execution options (including timeout/background/cwd)
        # and every unknown field still distinguish grants. MCP stays exact.
        fields["title"] = None
        fields["arguments"] = {key: value for key, value in arguments.items() if key != "description"}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


def visible_state(run: dict) -> str:
    return ("running" if run.get("_accessTransition") and not run.get("stopping")
            else "waiting-permission" if run.get("state") == "running"
            and run.get("permissionWaiting") else str(run.get("state") or "unknown"))


def snapshot(run: dict) -> dict:
    change = run.get("_accessTransition") or {}
    if change and change.get("phase") != "committed":
        # Preparation changes the private launch policy before the native ACK.
        # Public state remains on the previous policy until that ACK commits.
        previous = change.get("previousPolicy") or run.get("accessPolicy") or {}
        applied = run.get("appliedAccessPolicy") or {}
        return {"accessPolicy": dict(previous),
                "nextAccessPolicy": dict(change.get("targetPolicy") or {}) if not change.get("cancelled") and not change.get("error") else {},
                "accessControl": capability(str(run.get("cli") or "")),
                "appliedAccessPolicy": dict(applied) if applied.get("policyHash") == previous.get("policyHash") else {},
                "pendingPermissions": []}
    return {"accessPolicy": dict(run.get("accessPolicy") or {}),
            "nextAccessPolicy": dict(run.get("nextAccessPolicy") or {}),
            "accessControl": capability(str(run.get("cli") or "")),
            "appliedAccessPolicy": dict(run.get("appliedAccessPolicy") or {}),
            "pendingPermissions": [dict(row) for row in run.get("pendingPermissions", [])]}


def schedule(ref: str, value, expected_revision) -> dict:
    """Trusted desktop choice, persisted without changing a running turn."""
    from .local_base import _LOCK, _RUNS, _save_meta
    with _LOCK:
        run = _RUNS.get(ref)
        if not run:
            return {"ok": False, "error": "Session not found"}
        try:
            from . import codex_account_acp
            if issue := codex_account_acp.legacy_policy_issue(run, value):
                raise UnsupportedPolicyError(issue)
            policy = prepare(run["cli"], value, run["ws"])
            current = run.get("nextAccessPolicy") or run.get("accessPolicy") or {}
            revision = current.get("revision", 0)
            if type(expected_revision) is not int or expected_revision != revision:
                raise PolicyError("Stale access policy revision")
            if not policy or policy["revision"] != revision + 1:
                raise PolicyError("Access changes require the next policy revision")
        except PolicyError as exc:
            return {"ok": False, "code": exc.code, "error": str(exc)}
        run["nextAccessPolicy"] = policy
        result = {"ok": True, "effective": "next-turn", **snapshot(run)}
    _save_meta(ref)
    return result
