"""Interpret setup-probe replies without confusing protocol bytes with answers."""
from __future__ import annotations

import json
import re

_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])")


def _clean(value) -> str:
    return _ANSI.sub("", value) if isinstance(value, str) else ""


def _content(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(str(item.get("text") or "") for item in value
                       if isinstance(item, dict) and item.get("type") == "text")
    return ""


class _Replies:
    def __init__(self):
        self.streams: dict[str, tuple[str, bool]] = {}
        self.failure = ""
        self.pi_failure = ""
        self.pi_message = 0
        self.claude_message = ""
        self.ordinal = 0

    def claude_stop(self, reason):
        if reason in {"max_tokens", "model_context_window_exceeded", "refusal"}:
            self.failure = "模型输出达到上限、被截断或拒绝，本轮未完成（%s）" % reason

    def put(self, identity, value, *, delta=False, done=True):
        self.ordinal += 1
        key = str(identity or ("message:%s" % self.ordinal))
        previous, settled = self.streams.get(key, ("", False))
        chunk = value if isinstance(value, str) else ""
        # A reused native ID after completion starts a new answer. Empty done
        # markers close an existing stream without replaying/erasing its text.
        if delta:
            value = ("" if settled and chunk else previous) + chunk
        else:
            value = chunk
        self.streams[key] = (value, done)

    def message(self, message):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            return
        reason = str(message.get("stopReason") or "")
        self.claude_stop(message.get("stop_reason"))
        if reason in {"error", "aborted", "length", "max_tokens"}:
            self.pi_failure = str(message.get("errorMessage") or "模型调用失败、中断或输出未完成")
        elif reason == "stop":
            self.pi_failure = ""  # Pi may recover an earlier model retry.
        self.put("assistant:%s" % (message.get("id") or message.get("timestamp") or self.pi_message),
                 _content(message.get("content")))

    def event(self, event):
        kind = event.get("type")
        error = event.get("error")
        if error:
            self.failure = str(error.get("message") or error.get("name") or error) if isinstance(error, dict) else str(error)
        if kind == "turn.failed" or event.get("is_error") is True:
            errors = event.get("errors")
            details = "; ".join(value for value in errors if isinstance(value, str)) if isinstance(errors, list) else ""
            self.failure = str(event.get("result") or details or self.failure or "模型调用失败")
        if kind == "auto_retry_end" and event.get("success") is False:
            self.failure = str(event.get("finalError") or "模型重试失败")
        if kind == "message_start":
            if (event.get("message") or {}).get("role") == "assistant":
                self.pi_message += 1
            return
        if kind in {"message_end", "turn_end"}:
            self.message(event.get("message"))
            return
        if kind == "agent_end":
            for message in event.get("messages") or []:
                self.message(message)
            return
        if kind == "text" and isinstance(event.get("part"), dict):
            part = event["part"]
            identity = part.get("streamId") or part.get("id")
            delta = "delta" in part
            if delta and not identity:
                identity = "text:default"
            self.put(identity, part.get("delta") if delta else part.get("text"),
                     delta=delta, done=part.get("done") is not False)
            return
        if kind == "message_update" and isinstance(event.get("assistantMessageEvent"), dict):
            part = event["assistantMessageEvent"]
            identity = "pi:%s:%s" % (self.pi_message, part.get("contentIndex", 0))
            if part.get("type") == "text_delta":
                self.put(identity, part.get("delta"), delta=True, done=False)
            elif part.get("type") == "text_end":
                self.put(identity, part.get("content"), delta="content" not in part)
            return
        if kind in {"item.updated", "item.completed"} and isinstance(event.get("item"), dict):
            item = event["item"]
            if item.get("type") == "agent_message":
                self.put("codex:%s" % item.get("id", "answer"), item.get("text"), done=kind == "item.completed")
            return
        if kind == "assistant":
            self.message({"role": "assistant", **(event.get("message") or {})})
            return
        if kind == "stream_event" and isinstance(event.get("event"), dict):
            native = event["event"]
            event_type = native.get("type")
            if event_type == "message_start":
                self.claude_message = str((native.get("message") or {}).get("id") or self.ordinal + 1)
            if event_type == "message_delta":
                self.claude_stop((native.get("delta") or {}).get("stop_reason"))
            identity = "claude:%s:%s" % (self.claude_message, native.get("index", 0))
            if self.claude_message and event_type == "content_block_start":
                block = native.get("content_block") or {}
                if block.get("type") == "text":
                    self.put(identity, block.get("text"), done=False)
            elif self.claude_message and event_type == "content_block_delta":
                part = native.get("delta") or {}
                if part.get("type") == "text_delta":
                    self.put(identity, part.get("text"), delta=True, done=False)
            elif self.claude_message and event_type == "content_block_stop":
                self.put(identity, "", delta=True)
            return
        if kind == "result" and not event.get("is_error"):
            self.put("result", event.get("result"))


def _responses(output: str) -> tuple[list[str], str]:
    replies, plain, structured = _Replies(), [], False
    malformed = False
    for line in str(output or "").splitlines():
        line = _clean(line).lstrip("\ufeff").strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            if line.startswith("{"):
                malformed = True
            if not line.startswith(("{", "[")):
                plain.append(line)
            continue
        if isinstance(event, dict):
            structured = True
            try:
                replies.event(event)
            except (TypeError, AttributeError) as exc:
                # Unsupported nested shapes are an explicit failed probe, even
                # if an earlier answer contained the token. Never leak raw data.
                replies.failure = "CLI 输出协议格式无效（%s），请检查 CLI 版本与适配器" % type(exc).__name__
    if structured and malformed and not replies.failure:
        replies.failure = "CLI 输出协议 JSON 不完整或格式无效，请检查 CLI 版本与适配器"
    answers = [_clean(value) for value, done in replies.streams.values() if done]
    return (answers if structured else ["\n".join(plain)]), replies.failure or replies.pi_failure


def probe_succeeded(output: str, code: int, token: str) -> bool:
    answers, failure = _responses(output)
    return code == 0 and not failure and any(token in value for value in answers)


_ERR_FIELD = re.compile(r'"(?:finalError|errorMessage|error_message)"\s*:\s*"([^"]{2,200})"')
_HINTS = [
    ("authentication_failed", "它自己还没登录（这个 CLI 用它自己的账号）——去执行机上跑一次它，按提示登录一下"),
    ("not logged in", "它自己还没登录——去执行机上跑一次它，按提示登录一下"),
    ("invalid api key", "密钥不对或已过期"),
    ("incorrect api key", "密钥不对或已过期"),
    ("unauthorized", "密钥不对或已过期"),
    ("please run", "它要求先在执行机上跑一次登录或初始化"),
    ("connection error", "连不上模型服务（地址不通，或者这台机器上不了那个网）"),
    ("econnrefused", "连不上模型服务（端口不通）"),
    ("enotfound", "模型服务的地址解析不了"),
    ("fetch failed", "连不上模型服务（地址不通，或者这台机器上不了那个网）"),
    ("etimedout", "连模型服务超时，请检查网络连接与代理设置"),
    ("certificate", "证书校验没过"),
    ("context length", "这一轮的内容超过模型窗口了"),
]
_CODE_HINTS = [("401", "密钥不对或已过期"), ("403", "这把密钥没有这个模型的权限"), ("404", "地址或模型名不对")]


def _hint_in(text: str, *, allow_codes: bool) -> str:
    low = (text or "").lower()
    for key, message in _HINTS:
        if key in low:
            return message
    if allow_codes:
        for key, message in _CODE_HINTS:
            if re.search(r"(?<!\d)" + key + r"(?!\d)", low):
                return message
    return ""


def _why_failed(out: str, code: int) -> str:
    """Only inspect HTTP codes inside a real error, never random event IDs."""
    answers, failure = _responses(out)
    hits = _ERR_FIELD.findall(out or "")
    said = (failure or (hits[-1] if hits else "")).strip()[:160]
    if said:
        hint = _hint_in(said, allow_codes=True)
        return f"{hint}　（它自己报的是：{said}）" if hint else f"它自己报的是：{said}"
    hint = _hint_in(out or "", allow_codes=False)
    if hint:
        return hint
    if code == 124:
        return "探活超时，进程没有在限定时间内正常结束，请检查模型连接后重试"
    if code & 0xFFFFFFFF == 0xC0000142:
        return ("探活进程在 Windows 初始化阶段退出（0xC0000142，DLL 初始化失败），"
                "请检查实际 Runner 的运行环境、依赖及系统保护记录；本次未能验证模型对话")
    if code:
        return f"探活进程未正常结束（退出码 {code}），请查看日志后重试"
    reply = " ".join(value.strip() for value in answers if value.strip())[:160]
    if reply:
        return "跑完了但没收到完整口令。它回复的是：" + reply
    return "没有收到完整的助手回复（退出码 0），请检查模型连接后重试"
