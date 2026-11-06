"""Cooperative current-turn access changes; never replay a user request/tool."""
from __future__ import annotations

import time
import uuid

from . import access_policy
from .local_base import _LOCK, _RUNS, _save_meta

CONTINUATION = (
    "[SoduWork internal permission transition] Continue the current task from the "
    "saved session and completed tool results. The user changed access permissions. "
    "Do not restart the original request or repeat completed operations. "
    "If an operation was interrupted or its result is uncertain, inspect its state "
    "before acting; never blindly retry a command, write, upload or external action."
)


def active(run):
    change = run.get("_accessTransition") or {}
    return bool(change and change.get("phase") in {"waiting", "cancelling", "ready", "in-process-applying"}
                and not change.get("error") and not change.get("cancelled"))


def control(ref, policy, payload):
    """Called only over the launch-specific authenticated bridge channel."""
    with _LOCK:
        run = _RUNS.get(ref) or {}
        change = run.get("_accessTransition") or {}
        expected_hash = ((change.get("targetPolicy") or {}).get("policyHash")
                         if change.get("phase") == "in-process-applying" else change.get("oldHash"))
        if not change or change.get("phase") == "committed" or expected_hash != policy.get("policyHash"):
            return {"requested": False}
        if change.get("cancelled") or run.get("stopping"):
            return {"requested": False, "cancelled": True}
        stage = payload.get("stage")
        if stage != "query" and payload.get("id") != change["id"]:
            return {"requested": False}
        if stage == "cancel-sent":
            change["phase"] = "cancelling"
        elif stage == "in-process-ready":
            if (not change.get("allowInProcess") or change.get("phase") not in {"waiting", "cancelling"}
                    or not payload.get("sessionId") or payload["sessionId"] != run.get("cliSid")):
                return {"requested": False}
            # The bridge has safely settled the old native turn; it cannot send
            # another prompt until mode ACK and the matching commit below.
            change.update(phase="in-process-applying", inProcess=True)
            _install(run, change["targetPolicy"])
            return {"requested": True, "id": change["id"],
                    "policy": dict(change["targetPolicy"]), "continuation": CONTINUATION}
        elif stage == "in-process-applied":
            applied = run.get("appliedAccessPolicy") or {}
            if (not change.get("inProcess") or applied.get("state") != "applied"
                    or applied.get("policyHash") != expected_hash):
                return {"requested": False}
            change["phase"] = "committed"
            return {"requested": True, "id": change["id"]}
        elif stage == "ready":
            change.update(phase="ready", nativeId=str(payload.get("sessionId") or ""),
                          completed=bool(payload.get("completed")))
        elif stage == "failed":
            change["error"] = str(payload.get("error") or "Unable to safely change access")
        return {"requested": not bool(change.get("error")), "id": change["id"],
                "inProcess": bool(change.get("allowInProcess"))}


def finish(ref, code, hard_error):
    """Intercept exactly the old worker's exit, before normal turn settlement."""
    with _LOCK:
        run = _RUNS.get(ref) or {}
        change = run.get("_accessTransition") or {}
        if not change or change.get("phase") in {"applying", "in-process-applying", "committed"} or change.get("cancelled"):
            return False
        if run.get("stopping"):
            change["cancelled"] = True
            return False
        if change.get("phase") != "ready" or hard_error or code not in (0, 73):
            change.setdefault("error", hard_error or "The Agent did not confirm a safe cancellation")
            return False
        run.update(state="access-changing", proc=None, pid=0)
        change["oldExited"] = True
        return True


def cancel(run):
    """A real user stop wins over the internal continuation."""
    change = run.get("_accessTransition")
    if not change:
        return False
    change["cancelled"] = True
    if run.get("state") == "access-changing":
        run.update(state="stopped", stopping=False, error="Stopped during permission change")
        run["queue"] = []
        return True
    return False


def _install(run, policy):
    run["accessPolicy"] = policy
    run.pop("nextAccessPolicy", None)
    run.pop("_accessSessionGrants", None)
    run.pop("_accessSessionDenials", None)
    run.update(appliedAccessPolicy={}, pendingPermissions=[], permissionWaiting=False)
    run["mode"] = "plan" if policy["mode"] == "readonly" else "work"
    from . import codex_account_acp
    run["cfg"] = {**(run.get("cfg") or {}), **codex_account_acp.retained_config(run), "accessPolicy": policy,
                  "_soduwork_agent_mode": run["mode"]}


def _restore_failed(ref, run, old):
    # No new prompt is allowed until the bridge acknowledges native permissions.
    from .local_stream import _kill_tree
    from . import access_broker
    with _LOCK:
        change = run.get("_accessTransition")
        if change:
            # Fence late native ACKs before slow process cleanup can yield to them.
            change["cancelled"] = True
    _kill_tree(ref)
    access_broker.close(ref)
    with _LOCK:
        for key, prior in old.items():
            if prior is None:
                run.pop(key, None)
            else:
                run[key] = prior
        run.update(state="interrupted", proc=None, pid=0, appliedAccessPolicy={},
                   error="The Agent did not confirm the new permissions; the saved session is preserved")
    return {"ok": False, "error": run["error"]}


def apply(ref, value, expected_revision, *, timeout=40):
    """Trusted desktop entry. Success requires native mode ACK for a live turn."""
    with _LOCK:
        run = _RUNS.get(ref)
        if not run:
            return {"ok": False, "error": "Session not found"}
        if run.get("_accessTransition") or run.get("stopping"):
            return {"ok": False, "error": "The session is already changing or stopping"}
        try:
            from . import codex_account_acp
            if issue := codex_account_acp.legacy_policy_issue(run, value):
                raise access_policy.UnsupportedPolicyError(issue)
            policy = access_policy.prepare(run["cli"], value, run["ws"])
            current = run.get("nextAccessPolicy") or run.get("accessPolicy") or {}
            if (type(expected_revision) is not int or expected_revision != current.get("revision", 0)
                    or not policy or policy["revision"] != expected_revision + 1):
                raise access_policy.PolicyError("Stale access policy revision")
        except access_policy.PolicyError as exc:
            return {"ok": False, "code": exc.code, "error": str(exc)}
        if run.get("state") not in {"running", "recovering", "access-changing"}:
            _install(run, policy)
            _save_meta(ref)
            return {"ok": True, "effective": "current-turn", **access_policy.snapshot(run)}
        if not run.get("accessPolicy") or run.get("detached") or run.get("state") != "running":
            return {"ok": False, "error": "This running session cannot safely change permissions; stop it first"}
        old = {key: run.get(key) for key in ("accessPolicy", "nextAccessPolicy", "cfg", "mode", "appliedAccessPolicy")}
        change = {"id": uuid.uuid4().hex, "phase": "waiting",
                  "oldHash": run["accessPolicy"]["policyHash"],
                  "previousPolicy": run["accessPolicy"], "targetPolicy": policy}
        # Standard/full share the initialize-time fs/terminal capability set.
        # These verified native modes can be changed between turns without
        # restarting the CLI or reloading its saved session. Read-only changes
        # require a fresh capability handshake; OpenCode pins its map at boot.
        applied = run.get("appliedAccessPolicy") or {}
        change["allowInProcess"] = bool(run["cli"] in {"qwen", "codex-harness"}
            and run.get("cliSid") and applied.get("state") == "applied"
            and applied.get("policyHash") == run["accessPolicy"]["policyHash"]
            and run["accessPolicy"]["mode"] in {"standard", "full"}
            and policy["mode"] in {"standard", "full"})
        run["_accessTransition"] = change
    from . import access_broker
    access_broker.wake(ref)
    deadline = time.monotonic() + timeout
    result = None
    try:
        while time.monotonic() < deadline:
            with _LOCK:
                if change.get("phase") == "committed":
                    return {"ok": True, "effective": "current-turn", **access_policy.snapshot(run)}
                if change.get("cancelled") or run.get("stopping"):
                    result = {"ok": False, "error": "Permission change cancelled because the session was stopped"}
                    break
                if change.get("error"):
                    result = {"ok": False, "error": change["error"]}
                    break
                exited = change.get("oldExited")
            if exited:
                break
            time.sleep(.025)
        else:
            result = {"ok": False, "error": "The Agent did not reach a safe permission-change boundary in time"}
        if result:
            if change.get("inProcess"):
                return _restore_failed(ref, run, old)
            return result
        with _LOCK:
            if change.get("cancelled") or run.get("stopping"):
                return {"ok": False, "error": "Permission change cancelled"}
            if not change.get("nativeId") or change["nativeId"] != run.get("cliSid"):
                run.update(state="interrupted", error="Native session identity could not be verified")
                return {"ok": False, "error": run["error"]}
            change["phase"] = "applying"
            if change.get("completed"):
                _install(run, policy)
                # The old turn completed naturally; preserve normal settlement/queue handling.
                run["state"] = "running"
                run.pop("_accessTransition", None)
                from .local_stream import _finish
                _finish(ref, 0, {"completed": True}, "")
                return {"ok": True, "effective": "current-turn", **access_policy.snapshot(run)}
        from .local_ctx import prepare_resume
        launched = prepare_resume(ref, CONTINUATION, {"accessPolicy": policy}, recovery=True)
        if not launched.get("ok"):
            if change.get("cancelled"):
                return {"ok": False, "error": "Permission change cancelled"}
            return _restore_failed(ref, run, old)
        # A separate initialization deadline leaves time after a long-running tool.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            with _LOCK:
                applied = run.get("appliedAccessPolicy") or {}
                if change.get("cancelled") or run.get("stopping"):
                    return {"ok": False, "error": "Permission change cancelled"}
                if applied.get("policyHash") == policy["policyHash"] and applied.get("state") == "applied":
                    change["phase"] = "committed"
                    return {"ok": True, "effective": "current-turn", **access_policy.snapshot(run)}
                if run.get("state") != "running":
                    break
            time.sleep(.025)
        # Failed initialization must not run later under an unacknowledged policy.
        return _restore_failed(ref, run, old)
    finally:
        with _LOCK:
            if run.get("_accessTransition") is change:
                run.pop("_accessTransition", None)
        _save_meta(ref)
