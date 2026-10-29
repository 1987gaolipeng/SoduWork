"""Private, authenticated Runner ↔ trusted ACP bridge approval channel.

Agent stdout is never an authorization input. The per-launch bearer token is
passed only to the trusted bridge, removed before its agent is started, and
never serialized into run metadata or command arguments. This is an approval
transport, not an OS boundary against an already compromised same-user process.
"""
from __future__ import annotations

import hmac
import hashlib
import json
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import access_policy

_CHANNELS: dict[str, "Channel"] = {}
_CHANNEL_LOCK = threading.Lock()
_MAX_BODY = 65536
_TIMEOUT_S = 15 * 60


class Channel:
    def __init__(self, ref: str, policy: dict, agent: str):
        self.ref, self.policy, self.agent = ref, dict(policy), agent
        self.token = secrets.token_urlsafe(48)
        self.condition = threading.Condition(threading.RLock())
        self.pending: dict[str, dict] = {}
        self.decisions: dict[str, str] = {}
        self.grants: set[str] = set()
        self.denials: set[str] = set()
        from .local_base import _RUNS
        run = _RUNS.get(ref) or {}
        self.grants.update(run.get("_accessSessionGrants") or [])
        self.denials.update(run.get("_accessSessionDenials") or [])
        self.closed = False
        channel = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                authorization = self.headers.get("Authorization", "")
                if not hmac.compare_digest(authorization, "Bearer " + channel.token):
                    self.send_error(403)
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0 or length > _MAX_BODY:
                        raise ValueError("invalid body length")
                    payload = json.loads(self.rfile.read(length))
                    if not isinstance(payload, dict):
                        raise ValueError("invalid body")
                    if self.path == "/request":
                        result = {"decision": channel.request(payload)}
                    elif self.path == "/applied":
                        result = channel.applied(payload)
                    elif self.path == "/control":
                        result = channel.control(payload)
                    else:
                        self.send_error(404)
                        return
                    body = json.dumps(result).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (ValueError, TypeError):
                    self.send_error(400)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = "http://127.0.0.1:%s" % self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       name="permission:" + ref[:8], daemon=True)
        self.thread.start()

    def _publish(self):
        from .local_base import _LOCK, _RUNS
        with _LOCK:
            run = _RUNS.get(self.ref)
            if run is not None:
                run["pendingPermissions"] = [dict(row) for row in self.pending.values()]
                run["permissionWaiting"] = bool(self.pending)
                # Resume normal idle timing after a human has answered.
                run["lastOut"] = time.time()

    def applied(self, value: dict) -> dict:
        if value.get("mode") != self.policy["mode"]:
            return {"ok": False, "error": "Applied mode mismatch"}
        from .local_base import _LOCK, _RUNS, _save_meta
        with _LOCK:
            run = _RUNS.get(self.ref)
            if not run or self.closed or (run.get("accessPolicy") or {}).get("policyHash") != self.policy.get("policyHash"):
                return {"ok": False}
            run["appliedAccessPolicy"] = {
                **self.policy, "agent": self.agent,
                "enforcement": "native-permissions-and-host-tools", "sandbox": False,
                "nativeMode": str(value.get("nativeMode") or ""),
                "state": "applied", "appliedAt": time.time()}
        _save_meta(self.ref)
        return {"ok": True}

    def control(self, payload: dict) -> dict:
        from . import access_transition
        with self.condition:
            if self.closed:
                return {"requested": False}
            result = access_transition.control(self.ref, self.policy, payload)
            policy = result.get("policy")
            if result.get("requested") and payload.get("stage") == "in-process-ready" and policy:
                # This is the same private launch channel, after the old prompt
                # settled. Never carry grants/denials across policy revisions.
                self.policy = dict(policy)
                self.grants.clear()
                self.denials.clear()
                self.decisions.clear()
                self.pending.clear()
                self._publish()
            return result

    def _audit(self, request: dict, decision: str):
        from .local_base import _record_event
        _record_event(self.ref, {
            "kind": "permission", "tool": "", "text": decision,
            "permission": {"requestId": request["requestId"], "decision": decision,
                           "policyRevision": self.policy["revision"],
                           "argsDigest": request["argsDigest"],
                           "grantDigest": request.get("grantDigest", request["argsDigest"]),
                           "sessionScope": request.get("sessionScope"),
                           "action": request["action"], "target": request["target"]}})

    def _denied(self):
        from .local_base import _LOCK, _RUNS
        with _LOCK:
            run = _RUNS.get(self.ref)
            if run is not None:
                run["permissionDenied"] = True
                run["_accessSessionDenials"] = set(self.denials)

    def request(self, operation: dict) -> str:
        if not operation.get("action"):
            return "deny"
        digest = hashlib.sha256(json.dumps([
            self.policy.get("policyHash"), self.agent, access_policy.operation_digest(operation)
        ], separators=(",", ":")).encode()).hexdigest()
        # A scope is an explicit alternative to the exact-operation session
        # grant. It never changes automatic/default access or once/deny rules.
        scope = None
        if (self.agent == "codex-harness" and operation.get("allowSession", True)
                and operation.get("action") == "native.command"):
            from .access_command_scope import preview_scope
            from .skill_read_scope import channel_scope
            from .local_base import _RUNS
            scope = preview_scope(operation, self.policy, channel_scope(_RUNS.get(self.ref) or {}))
        grant_digest = (hashlib.sha256(json.dumps([
            self.policy.get("policyHash"), self.agent, scope
        ], sort_keys=True, separators=(",", ":")).encode()).hexdigest() if scope else digest)
        with self.condition:
            from . import access_transition
            from .local_base import _RUNS
            if access_transition.active(_RUNS.get(self.ref) or {}):
                return "deny"
            if self.closed or self.policy["mode"] == "readonly":
                self._denied()
                return "deny"
            if self.policy["mode"] == "full":
                return "once"
            if digest in self.denials:
                self._denied()
                return "deny"
            if operation.get("allowSession", True) and grant_digest in self.grants:
                return "once"
            request_id = uuid.uuid4().hex
            now = time.time()
            row = {"requestId": request_id, "ref": self.ref, "agent": self.agent,
                   "policyRevision": self.policy["revision"],
                   "operationId": str(operation.get("operationId") or uuid.uuid4().hex),
                   "action": str(operation["action"])[:100],
                   "kind": str(operation.get("kind") or "")[:100],
                   "tool": str(operation.get("tool") or "")[:100],
                   "target": str(operation.get("target") or "")[:2000],
                   "title": str(operation.get("title") or operation["action"])[:300],
                   "reason": str(operation.get("reason") or "")[:500],
                   "arguments": operation.get("arguments") or {},
                   "argsDigest": digest, "createdAt": now,
                   "grantDigest": grant_digest,
                   "sessionScope": {"kind": scope["kind"]} if scope else None,
                   "expiresAt": now + _TIMEOUT_S,
                   "allowSession": bool(operation.get("allowSession", True))}
            self.pending[request_id] = row
            self._publish()
            self._audit(row, "requested")
            try:
                while request_id not in self.decisions and not self.closed:
                    from .local_base import _RUNS
                    run = _RUNS.get(self.ref) or {}
                    if run.get("state") != "running" or run.get("stopping") or access_transition.active(run):
                        break
                    remaining = row["expiresAt"] - time.time()
                    if remaining <= 0:
                        break
                    self.condition.wait(min(1, remaining))
                answer = self.decisions.pop(request_id, "deny")
                if self.closed:
                    answer = "deny"
                if answer == "deny" and not access_transition.active(_RUNS.get(self.ref) or {}):
                    self.denials.add(digest)
                    self._denied()
                self._audit(row, answer)
                return "once" if answer == "session" else answer
            finally:
                self.pending.pop(request_id, None)
                self._publish()

    def respond(self, request_id: str, decision: str, revision) -> dict:
        with self.condition:
            row = self.pending.get(request_id)
            from .local_base import _RUNS
            run = _RUNS.get(self.ref) or {}
            from . import access_transition
            if (access_transition.active(run) or self.closed or not row or request_id in self.decisions
                    or run.get("state") != "running" or run.get("stopping")
                    or row["expiresAt"] <= time.time()):
                return {"ok": False, "code": "PERMISSION_REQUEST_EXPIRED",
                        "error": "This permission request is no longer pending"}
            if type(revision) is not int or revision != self.policy["revision"]:
                return {"ok": False, "code": "PERMISSION_POLICY_CHANGED",
                        "error": "The access policy has changed"}
            if (run.get("accessPolicy") or {}).get("policyHash") != self.policy.get("policyHash"):
                return {"ok": False, "code": "PERMISSION_POLICY_CHANGED",
                        "error": "The access policy has changed"}
            if decision not in {"once", "session", "deny"}:
                return {"ok": False, "error": "Invalid permission decision"}
            if decision == "session" and not row["allowSession"]:
                return {"ok": False, "error": "This action requires one-time permission"}
            if decision == "session":
                self.grants.add(row["grantDigest"])
            elif decision == "deny":
                self.denials.add(row["argsDigest"])
            self.decisions[request_id] = decision
            if decision != "once":
                for other_id, other in self.pending.items():
                    if (other_id not in self.decisions
                            and (other["grantDigest"] == row["grantDigest"] if decision == "session"
                                 else other["argsDigest"] == row["argsDigest"])
                            and other["expiresAt"] > time.time()
                            and (decision == "deny" or other["allowSession"])):
                        self.decisions[other_id] = decision
            run["_accessSessionGrants"] = set(self.grants)
            run["_accessSessionDenials"] = set(self.denials)
            self.condition.notify_all()
            return {"ok": True, "requestId": request_id, "decision": decision}

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()
            self.pending.clear()
            self._publish()
        self.server.shutdown()
        self.server.server_close()


def attach(ref: str, cfg: dict, env: dict) -> Channel | None:
    policy = cfg.get("accessPolicy")
    if not policy:
        return None
    close(ref)
    from .local_base import _LOCK, _RUNS
    with _LOCK:
        # Turn completion scrubs cfg, while the trusted run retains identity.
        # Follow-ups must keep grants scoped to that same Agent, not an empty
        # cfg field or a caller-supplied replacement identity.
        agent = str((_RUNS.get(ref) or {}).get("cli") or cfg.get("local_cli") or "")
    channel = Channel(ref, policy, agent)
    with _CHANNEL_LOCK:
        _CHANNELS[ref] = channel
    from .skill_read_scope import channel_scope
    with _LOCK:
        read_scope = channel_scope(_RUNS.get(ref) or {}).payload()
    env["SODUWORK_APPROVAL_CHANNEL"] = json.dumps({"url": channel.url,
                                              "readScope": read_scope,
                                              "token": channel.token,
                                              "policy": policy})
    return channel


def respond(ref: str, request_id: str, decision: str, revision) -> dict:
    with _CHANNEL_LOCK:
        channel = _CHANNELS.get(ref)
    if not channel:
        return {"ok": False, "code": "PERMISSION_REQUEST_EXPIRED",
                "error": "The permission channel is no longer available"}
    return channel.respond(request_id, decision, revision)


def wake(ref: str):
    with _CHANNEL_LOCK:
        channel = _CHANNELS.get(ref)
    if channel:
        with channel.condition:
            channel.condition.notify_all()


def close(ref: str):
    with _CHANNEL_LOCK:
        channel = _CHANNELS.pop(ref, None)
    if channel:
        channel.close()
