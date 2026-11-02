"""Shared model gateway errors for synchronous probes and async transports."""

import json
import re


def public_failure(value) -> str:
    """Classify provider diagnostics without exposing response bodies or credentials."""
    raw = str(value or "")[:16000]
    payload = value if isinstance(value, dict) else None
    if payload is None:
        try:
            payload = json.loads(raw[raw.index("{"):])
        except (ValueError, TypeError):
            pass
    status = 0
    if isinstance(payload, dict):
        nested = payload.get("error")
        for item in (nested, payload):
            if not isinstance(item, dict):
                continue
            for key in ("status", "statusCode", "code"):
                candidate = str(item.get(key) or "")
                if re.fullmatch(r"[45]\d{2}", candidate):
                    status = int(candidate)
                    break
            if status:
                break
    if not status:
        match = re.search(
            r"\bHTTP(?:/\d(?:\.\d)?)?\s+([45]\d{2})\b"
            r"|^([45]\d{2})(?=$|[\s:<({])"
            r"|\bstatus(?:[_ ]?code)?\s*[:=]?\s*([45]\d{2})\b", raw, re.I)
        if match:
            status = int(next(group for group in match.groups() if group))
    suffix = f"（HTTP {status}）" if status else ""
    if status == 404:
        return "模型服务地址或模型不存在" + suffix + "；请切换可用模型，或联系管理员核对服务地址与模型名称。"
    if status in {401, 403}:
        return "模型服务拒绝了当前凭据或模型权限" + suffix + "；请检查模型授权或切换有权限的模型。"
    if status == 429:
        return "模型服务当前繁忙或额度受限" + suffix + "；请稍后重试或检查模型额度。"
    if status in {408, 425} or status >= 500 or re.search(
            r"timeout|timed\s*out|ECONNRESET|ECONNREFUSED|fetch failed|connection error", raw, re.I):
        return "模型服务暂时不可用" + suffix + "；请稍后重试，已有进度已保留。"
    if status:
        return "模型服务未能处理当前请求" + suffix + "；请检查模型配置和输入内容。"
    return "模型调用失败，已有进度已保留；请重试或切换可用模型。"


class UpstreamError(Exception):
    """Preserve the gateway status and response without converting it to HTTP 500."""

    def __init__(self, status: int, body: str, detail: str = ""):
        super().__init__(detail or f"HTTP {status}")
        self.status = status
        self.body = body
        self.detail = detail or f"HTTP {status}"
