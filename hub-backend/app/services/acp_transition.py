"""Trusted ACP event-loop helper for cooperative permission reconfiguration."""
from __future__ import annotations

import time

try:
    from .acp_access import AccessError
except ImportError:
    from acp_access import AccessError


class Transition:
    def __init__(self, bridge):
        self.bridge = bridge
        self.resumable = False
        self.requested = ""
        self.cancel_sent = False
        self.tools = {}
        self.blocked = set()
        self.failed_after_cancel = set()
        self.next_poll = 0.0
        self.in_process = False
        self.reconfiguration = None

    def update(self, update):
        kind = update.get("sessionUpdate")
        if kind not in {"tool_call", "tool_call_update"}:
            return
        tool_id = str(update.get("toolCallId") or "")
        if not tool_id:
            return
        status = str(update.get("status") or ("pending" if kind == "tool_call" else ""))
        if status:
            self.tools[tool_id] = status
            if self.cancel_sent and status == "failed" and tool_id not in self.blocked:
                self.failed_after_cancel.add(tool_id)

    def result_fields(self, update):
        # Only an approval withdrawn by this trusted transition proves the tool
        # never received permission. A running tool failure remains a failure.
        tool_id = str(update.get("toolCallId") or "")
        if update.get("status") == "failed" and tool_id in self.blocked:
            return {"state": "cancelled", "cancelReason": "access-change", "isError": False}
        return {"isError": update.get("status") == "failed"}

    def busy(self):
        return (any(status not in {"completed", "failed"} and key not in self.blocked
                    for key, status in self.tools.items())
                or any(terminal.status() is None for terminal in self.bridge.terminals.values()))

    def report(self, stage, **extra):
        return self.bridge.access.call("/control", {"id": self.requested, "stage": stage, **extra})

    def tick(self, method):
        if not self.bridge.access.enabled or time.monotonic() < self.next_poll:
            return
        self.next_poll = time.monotonic() + .15
        response = self.report("query")
        self.requested = str(response.get("id") or "") if response.get("requested") else ""
        self.in_process = bool(response.get("inProcess"))
        if not self.requested or method != "session/prompt" or self.cancel_sent:
            return
        if not self.resumable:
            self.report("failed", error="This Agent cannot safely resume its native session")
            self.requested = ""
            return
        if self.busy():
            return
        # Record the handshake before cancel, so a timeout cannot race a late cancellation.
        acknowledged = self.report("cancel-sent")
        if not acknowledged.get("requested") or acknowledged.get("id") != self.requested:
            self.requested = ""
            return
        self.cancel_sent = True
        self.bridge.send({"jsonrpc": "2.0", "method": "session/cancel",
                          "params": {"sessionId": self.bridge.session_id}})

    def permission_blocked(self, params):
        if not self.requested:
            return False
        tool_id = str((params.get("toolCall") or {}).get("toolCallId") or "")
        if tool_id:
            self.blocked.add(tool_id)
        return True

    def complete(self, result):
        # The prompt may complete while a change is waiting for initialization/a tool.
        self.next_poll = 0
        self.tick("complete")
        if not self.requested:
            return False
        if self.busy() or self.failed_after_cancel:
            self.report("failed", error="A tool did not finish safely; inspect its result before continuing")
            return False
        reason = str(result.get("stopReason") or "")
        if reason not in {"", "end_turn", "cancelled"}:
            self.report("failed", error="The Agent did not acknowledge a safe cancellation")
            return False
        completed = not self.cancel_sent and not self.blocked and reason in {"", "end_turn"}
        if self.in_process:
            reply = self.report("in-process-ready", sessionId=self.bridge.session_id, completed=completed)
            if not reply.get("requested") or reply.get("id") != self.requested or not reply.get("policy"):
                raise AccessError("Permission change was cancelled before native reconfiguration")
            self.reconfiguration = {**reply, "completed": completed}
        else:
            self.report("ready", sessionId=self.bridge.session_id, completed=completed)
        return True

    def reconfigure(self, session_config):
        """Reuse a settled native session, never replay the original prompt."""
        config = self.reconfiguration
        if not config:
            return None
        try:
            self.bridge.access.policy = dict(config["policy"])
            self.bridge.access.mode = str(config["policy"]["mode"])
            self.bridge.access.apply(self.bridge, session_config)
            reply = self.report("in-process-applied")
            if not reply.get("requested") or reply.get("id") != self.requested:
                raise AccessError("Permission change was cancelled before native continuation")
        except Exception as exc:
            self.report("failed", error=str(exc) or "Native permission reconfiguration failed")
            raise
        continuation = "" if config["completed"] else config["continuation"]
        self.requested = ""
        self.cancel_sent = False
        self.tools.clear()
        self.blocked.clear()
        self.failed_after_cancel.clear()
        self.reconfiguration = None
        self.in_process = False
        return continuation
