"""Strict, bounded Chat Completions evidence parsing; diagnostics contain only codes."""
from __future__ import annotations

import codecs
import json
import math
import re


def compatibility(raw=None) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {**({"maxTokensField": raw["maxTokensField"]}
               if raw.get("maxTokensField") in ("max_tokens", "max_completion_tokens") else {}),
            **({"toolChoice": raw["toolChoice"]} if raw.get("toolChoice") in ("auto", "named") else {}),
            **({"streamOptions": raw["streamOptions"]} if type(raw.get("streamOptions")) is bool else {})}


class ProbeIssue(Exception):
    def __init__(self, code, status="inconclusive", *, detail_code=None):
        super().__init__(code)
        self.code, self.status = code, status
        self.detail_code = detail_code


def parse_json(raw):
    def invalid_constant(value):
        raise ValueError("invalid JSON constant")
    return json.loads(raw, parse_constant=invalid_constant)


def error_fields(error) -> dict:
    try:
        payload = parse_json(error.body)
    except (ValueError, TypeError):
        return {}
    value = payload.get("error") if isinstance(payload, dict) else None
    return value if isinstance(value, dict) else {}


def optional_parameter(error) -> str:
    if error.status not in (400, 422):
        return ""
    fields = error_fields(error)
    code = str(fields.get("code") or fields.get("type") or "").lower()
    text = str(fields.get("message") or "").lower()
    param = str(fields.get("param") or "").lower()
    allowed = ("max_tokens", "max_completion_tokens", "tool_choice", "stream_options")
    if code in ("unsupported_parameter", "unsupported_value", "unknown_parameter", "unrecognized_parameter"):
        if param in allowed:
            return param
    # Some gateways omit param/code but return a structured, explicit refusal.
    if re.search(r"not support|unsupported|unrecognized|unknown (?:parameter|argument)", text):
        for candidate in allowed:
            if re.search(r"(?<![a-z_])" + candidate + r"(?![a-z_])", text):
                return candidate
    return ""


def failure(error, check) -> tuple[str, str]:
    fields = error_fields(error)
    if str(fields.get("code") or "") in ("insufficient_quota", "insufficient_balance",
            "billing_hard_limit_reached", "billing_not_active", "1113"):
        return "failed", "billing_unavailable"
    if error.status in (408, 429, 500, 502, 503, 504):
        return "inconclusive", "timeout" if error.status in (408, 504) else "temporarily_unavailable"
    if error.status == 401:
        return "failed", "credentials_or_access"
    if error.status == 403:
        return "inconclusive", "request_rejected"
    if error.status == 404:
        return "failed", "model_or_endpoint_missing"
    if error.status in (400, 422):
        fields = error_fields(error)
        code = str(fields.get("code") or "").lower()
        param = str(fields.get("param") or "").lower()
        text = str(fields.get("message") or "").strip().lower()
        # Optional controls never establish that their associated feature is absent.
        if (param in ("max_tokens", "max_completion_tokens", "tool_choice", "stream_options")
                or optional_parameter(error) or any(value in text for value in ("tool_choice", "stream_options"))):
            return "inconclusive", "parameter_not_supported"
        codes = {"imageInput": {"image_not_supported", "unsupported_image", "unsupported_image_input", "vision_not_supported", "image_input_not_supported"},
                 "toolCalling": {"tools_not_supported", "tool_calling_not_supported", "function_calling_not_supported", "unsupported_tools"},
                 "streaming": {"streaming_not_supported", "stream_not_supported", "unsupported_streaming"}}
        patterns = {"imageInput": r"(?:image(?:s| input)?|vision|multimodal input) (?:is |are )?not supported(?: by (?:this |the )?model)?[.!]?",
                    "toolCalling": r"(?:tools|tool calling|function calling) (?:is |are )?not supported(?: by (?:this |the )?model)?[.!]?",
                    "streaming": r"streaming (?:is )?not supported(?: by (?:this |the )?model)?[.!]?"}
        primary = {"imageInput": {"image", "image_url"}, "toolCalling": {"tools", "functions"}, "streaming": {"stream"}}
        if (code in codes.get(check, set())
                or code == "unsupported_parameter" and param in primary.get(check, set())
                or check in patterns and re.fullmatch(patterns[check], text)):
            return "unsupported", "capability_not_supported"
    return "inconclusive", "request_not_accepted"


def meaningful(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _invalid_stream():
    return ProbeIssue("invalid_response", detail_code="invalid_stream_shape")


def _integer(value):
    return type(value) is int or type(value) is float and math.isfinite(value) and value.is_integer()


def _counter(value):
    return _integer(value) and 0 <= value <= 2 ** 53 - 1


def _usage(value):
    if (not isinstance(value, dict) or not any(_counter(value.get(key))
            for key in ("prompt_tokens", "completion_tokens", "total_tokens"))):
        return False
    for key, count in value.items():
        if key.endswith("_tokens_details"):
            if count is not None and (not isinstance(count, dict)
                    or any(item is not None and not _counter(item) for item in count.values())):
                return False
        elif not _counter(count):
            return False
    return True


def _envelope(value, *, usage_only=False):
    allowed = {"choices", "id", "object", "created", "model", "system_fingerprint", "service_tier", "usage"}
    if usage_only and set(value) - allowed:
        raise _invalid_stream()
    for key in ("id", "object", "model"):
        if key in value and not isinstance(value[key], str):
            raise _invalid_stream()
    for key in ("system_fingerprint", "service_tier"):
        if value.get(key) is not None and not isinstance(value[key], str):
            raise _invalid_stream()
    if "created" in value and not _counter(value["created"]):
        raise _invalid_stream()
    if usage_only or value.get("usage") is not None:
        if not _usage(value.get("usage")):
            raise _invalid_stream()


def _function_fields(value):
    return isinstance(value, dict) and all(key not in value or isinstance(value[key], str)
                                          for key in ("name", "arguments"))


TRUNCATED_REASONS = ("length", "max_tokens", "max_output_tokens")


def response_choice(value, *, allow_truncated=False):
    """Validate the bounded JSON response before treating its message as evidence."""
    if not isinstance(value, dict) or value.get("error") is not None or value.get("type") == "error":
        raise ProbeIssue("invalid_response")
    choices = value.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise ProbeIssue("invalid_response")
    choice = choices[0]
    if "index" in choice and (not _integer(choice["index"]) or choice["index"] != 0):
        raise ProbeIssue("invalid_response")
    if choice.get("logprobs") is not None and not isinstance(choice["logprobs"], dict):
        raise ProbeIssue("invalid_response")
    reason = choice.get("finish_reason")
    if reason in TRUNCATED_REASONS:
        if not allow_truncated:
            raise ProbeIssue("response_truncated")
    elif reason == "content_filter":
        raise ProbeIssue("content_filtered")
    elif reason not in (None, "stop", "tool_calls", "function_call"):
        raise ProbeIssue("invalid_response")
    message = choice.get("message")
    if not isinstance(message, dict) or "role" in message and message["role"] != "assistant":
        raise ProbeIssue("invalid_response")
    for key in ("content", "reasoning_content", "reasoning", "thinking", "refusal"):
        if message.get(key) is not None and not isinstance(message[key], str):
            raise ProbeIssue("invalid_response")
    if "tool_calls" in message and not isinstance(message["tool_calls"], list):
        raise ProbeIssue("invalid_response")
    for call in message.get("tool_calls", []):
        if (not isinstance(call, dict) or "id" in call and not isinstance(call["id"], str)
                or "type" in call and call["type"] != "function"
                or "function" in call and not _function_fields(call["function"])):
            raise ProbeIssue("invalid_response")
    if message.get("function_call") is not None and not _function_fields(message["function_call"]):
        raise ProbeIssue("invalid_response")
    return choice


class StreamEvidence:
    """Incremental UTF-8/SSE decoder including CR, CRLF, data folding and comments."""
    def __init__(self, limit):
        self.decoder = codecs.getincrementaldecoder("utf-8-sig")("strict")
        self.limit, self.size = limit, 0
        self.line, self.data, self.event = [], [], ""
        self.after_cr = False
        self.observed = self.reasoning = self.terminal = self.done = self.finished = False
        self.finish_reason = None
        self.legacy_call_observed = False
        self.calls, self.content, self.thoughts = {}, [], []

    def feed(self, raw):
        self.size += len(raw)
        if self.size > self.limit:
            raise ProbeIssue("response_limit")
        try:
            self._text(self.decoder.decode(raw))
        except UnicodeDecodeError as exc:
            raise _invalid_stream() from exc

    def _text(self, text):
        for char in text:
            if self.after_cr:
                self.after_cr = False
                if char == "\n":
                    continue
            if char in "\r\n":
                self._line()
                self.after_cr = char == "\r"
            else:
                self.line.append(char)

    def _line(self):
        line = "".join(self.line)
        self.line.clear()
        if not line:
            self._event()
        elif line.startswith(":"):
            return
        else:
            key, _, value = line.partition(":")
            if value.startswith(" "):
                value = value[1:]
            if key == "data":
                self.data.append(value)
            elif key == "event":
                self.event = value

    def _event(self):
        kind, self.event = self.event, ""
        had_data = bool(self.data)
        data, self.data = "\n".join(self.data), []
        if kind == "error":
            raise ProbeIssue("stream_error")
        if kind in ("ping", "heartbeat"):
            try:
                heartbeat = parse_json(data)
            except ValueError:
                return
            if isinstance(heartbeat, dict) and (heartbeat.get("error") is not None or heartbeat.get("type") == "error"):
                raise ProbeIssue("stream_error")
            return
        if kind not in ("", "message"):
            raise _invalid_stream()
        if not had_data:
            return
        if self.done:
            raise _invalid_stream()
        if data.strip() == "[DONE]":
            # The Chat Completions dialect defines this terminal marker.
            self.terminal = self.done = True
            return
        try:
            value = parse_json(data)
        except ValueError as exc:
            raise _invalid_stream() from exc
        if not isinstance(value, dict):
            raise _invalid_stream()
        if value.get("error") is not None or value.get("type") == "error":
            raise ProbeIssue("stream_error")
        choices = value.get("choices")
        if "choices" not in value or isinstance(choices, list) and not choices:
            _envelope(value, usage_only=True)
            return
        _envelope(value)
        if not isinstance(choices, list) or len(choices) > 1:
            raise _invalid_stream()
        for choice in choices:
            if not isinstance(choice, dict):
                raise _invalid_stream()
            if "index" in choice and (not _integer(choice["index"]) or choice["index"] != 0):
                raise _invalid_stream()
            if choice.get("logprobs") is not None and not isinstance(choice["logprobs"], dict):
                raise _invalid_stream()
            delta = choice.get("delta")
            reason = choice.get("finish_reason")
            if not isinstance(delta, dict) or self.finished and (delta or reason is not None):
                raise _invalid_stream()
            if "role" in delta and delta["role"] != "assistant":
                raise _invalid_stream()
            if delta.get("function_call") is not None and not _function_fields(delta["function_call"]):
                raise _invalid_stream()
            if delta.get("function_call") is not None:
                self.legacy_call_observed = True
            for key in ("content", "reasoning_content", "reasoning", "thinking", "refusal"):
                if delta.get(key) is not None and not isinstance(delta[key], str):
                    raise _invalid_stream()
            if reason in TRUNCATED_REASONS:
                raise ProbeIssue("response_truncated")
            if reason is not None:
                if reason not in ("stop", "tool_calls", "function_call", "content_filter"):
                    raise _invalid_stream()
                if reason == "content_filter":
                    raise ProbeIssue("content_filtered")
                self.finish_reason = reason
                self.terminal = self.finished = True
            content = delta.get("content")
            if content is not None:
                self.content.append(content)
            thought = any(meaningful(delta.get(key)) for key in ("reasoning_content", "reasoning", "thinking"))
            self.reasoning = self.reasoning or thought
            if isinstance(delta.get("reasoning_content"), str):
                self.thoughts.append(delta["reasoning_content"])
            calls = delta.get("tool_calls", [])
            if not isinstance(calls, list):
                raise _invalid_stream()
            self._tool_deltas(calls)
            self.observed = self.observed or thought or meaningful(content)

    def _tool_deltas(self, parts):
        for part in parts:
            if not isinstance(part, dict):
                raise _invalid_stream()
            index = part.get("index", 0)
            if not _integer(index) or not 0 <= index < 16 or len(parts) > 1 and "index" not in part:
                raise _invalid_stream()
            index = int(index)
            if "type" in part and part["type"] != "function":
                raise _invalid_stream()
            function = part.get("function", {})
            if not isinstance(function, dict):
                raise _invalid_stream()
            call = self.calls.setdefault(index, {"id": "", "type": "function",
                "function": {"name": "", "arguments": ""}})
            for target, source, key, limit in ((call, part, "id", 200),
                    (call["function"], function, "name", 128),
                    (call["function"], function, "arguments", self.limit)):
                fragment = source.get(key)
                if key in source:
                    if not isinstance(fragment, str):
                        raise _invalid_stream()
                    target[key] += fragment
                    if len(target[key]) > limit:
                        raise ProbeIssue("response_limit")

    def message(self) -> dict:
        result = {"role": "assistant", "content": "".join(self.content) or None}
        if self.calls:
            result["tool_calls"] = [self.calls[index] for index in sorted(self.calls)]
        if self.thoughts:
            result["reasoning_content"] = "".join(self.thoughts)
        return result

    def finish(self, *, require_output=True) -> tuple[bool, bool]:
        try:
            self._text(self.decoder.decode(b"", final=True))
        except UnicodeDecodeError as exc:
            raise _invalid_stream() from exc
        # A trailing unterminated data frame is truncated, even after prior text.
        if self.line or self.data or self.event:
            raise ProbeIssue("stream_incomplete")
        if not self.terminal:
            raise ProbeIssue("stream_incomplete")
        if require_output and not self.observed:
            raise ProbeIssue("expected_output_missing", detail_code="expected_output_mismatch")
        return self.observed, self.reasoning
