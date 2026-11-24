"""Negotiate and consume Codex ACP's typed terminal session failures.

Codex ACP can return ``end_turn`` even when its native turn failed. The
sessionFailure extension carries the authoritative current-turn failure in
the prompt result; prose and asynchronous session notices are not evidence.
"""
from __future__ import annotations
from collections import OrderedDict
import json
import re

_AGENTS = {"codex", "codex-harness"}
_VERSION = 1
_MAX_TITLE = 2000
_MALFORMED = "Codex 返回的失败信息无效，无法确认本轮已完成。请更新适配器后重试。"
_FAILED = "Codex 本轮执行失败，未收到可用的失败说明。"
ACCOUNT_MODEL_UNAVAILABLE = "当前 Codex 账号无法使用所选模型。请在此会话中切换到 Codex 默认模型或其他可用模型，再发送消息。"


def account_model_rejected(agent: str, event: dict) -> bool:
    """Recognize a terminal account-model rejection, never a tool or progress message."""
    error = event.get("error")
    if agent != "codex" or not isinstance(error, dict):
        return False
    if event.get("type") != "turn.failed" and error.get("name") != "AcpBridgeError":
        return False
    if error.get("code") == "model_not_found":
        return True
    message = error.get("message")
    if not isinstance(message, str):
        return False
    detail = message[:4000]
    if re.search(r"\bmodel is not supported when using Codex with a ChatGPT account\b", detail, re.I):
        return True
    try:
        payload, _ = json.JSONDecoder().raw_decode(detail[detail.index("{"):])
    except (ValueError, RecursionError):
        return False
    provider = payload.get("error", payload) if isinstance(payload, dict) else None
    return isinstance(provider, dict) and provider.get("code") == "model_not_found"


def capabilities(agent_name: str) -> dict:
    if agent_name not in _AGENTS:
        return {}
    return {"_meta": {"terminal_output_delta": True, "jetbrains": {"air": {
        "version": _VERSION, "capabilities": ["sessionFailure"],
    }}}}


def failure(agent_name: str, result: dict) -> str:
    """Return only a negotiated terminal failure, never a retry warning."""
    if agent_name not in _AGENTS or not isinstance(result, dict):
        return ""
    air = result
    for name in ("_meta", "jetbrains", "air"):
        air = air.get(name)
        if not isinstance(air, dict):
            return ""
    if "sessionFailure" not in air:
        return ""
    version, item = air.get("version"), air["sessionFailure"]
    # An advertised but unreadable failure must not turn into end_turn success.
    if type(version) is not int or version != _VERSION or not isinstance(item, dict):
        return _MALFORMED
    severity = item.get("severity")
    if severity == "warning":
        return ""
    if severity != "error":
        return _MALFORMED
    title = item.get("title")
    title = title.strip() if isinstance(title, str) else ""
    if not title:
        return _FAILED
    return title if len(title) <= _MAX_TITLE else title[:_MAX_TITLE - 1] + "…"


class ToolOutput:
    """Collect the AIR output contract until the existing terminal tool event.

    AIR has no content-block fallback for command stdout. Its explicit delta
    capability uses a tool-correlated terminal id; search/list results instead
    arrive as rawOutput snapshots. Neither form changes execution state.
    """

    MAX_TOOLS = 64
    MAX_TEXT = 20_000

    def __init__(self, agent_name: str):
        self.enabled = agent_name in _AGENTS
        self.pending: OrderedDict[str, str] = OrderedDict()

    def consume(self, update: dict) -> None:
        if not self.enabled or not isinstance(update, dict):
            return
        kind, tool_id = update.get("sessionUpdate"), update.get("toolCallId")
        if kind not in {"tool_call", "tool_call_update"} or not isinstance(tool_id, str) or not tool_id:
            return
        if kind == "tool_call":
            self.pending.pop(tool_id, None)
            self.pending[tool_id] = ""
        elif tool_id not in self.pending:
            # Late deltas cannot resurrect completed calls. A terminal snapshot
            # can still carry useful diagnostics when the start was not seen.
            if update.get("status") not in {"completed", "failed"}:
                return
            self.pending[tool_id] = ""
        raw_output = update.get("rawOutput")
        if isinstance(raw_output, str):
            self.pending[tool_id] = raw_output[:self.MAX_TEXT]
        else:
            meta = update.get("_meta")
            delta = meta.get("terminal_output_delta") if isinstance(meta, dict) else None
            if (isinstance(delta, dict) and delta.get("terminal_id") == tool_id
                    and isinstance(delta.get("data"), str)):
                remaining = self.MAX_TEXT - len(self.pending[tool_id])
                self.pending[tool_id] += delta["data"][:remaining]
        while len(self.pending) > self.MAX_TOOLS:
            self.pending.popitem(last=False)

    def finish(self, update: dict, fallback: str = "") -> str:
        """Preserve explicit content (especially errors), then use AIR output."""
        if not self.enabled:
            return fallback
        tool_id = update.get("toolCallId")
        output = self.pending.pop(tool_id, "") if isinstance(tool_id, str) else ""
        return fallback or output
