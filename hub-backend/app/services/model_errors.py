"""Shared model gateway errors for synchronous probes and async transports."""

import json
import re


OUTPUT_LIMIT_MESSAGE = "请求的最大输出 Token 超过模型服务限制；请在模型配置中调整“最大输出 Token”，并核对“上下文窗口”"
OUTPUT_LIMIT_RE = re.compile(
    r"\b(?:max_(?:completion_|output_)?tokens|maxOutputTokens)\b.{0,160}"
    r"(?:cannot be greater than|must be (?:less than|<=|at most)|exceeds?\b|too (?:large|high)"
    r"|maximum (?:allowed|value)|is (?:greater|higher) than)", re.I)


def output_limit_exceeded(value) -> bool:
    """Recognize an output-budget rejection without learning limits from provider text."""
    raw = str(value or "")[:16000]
    return bool(OUTPUT_LIMIT_RE.search(raw) or re.search(r"\boutput_token_limit_exceeded\b", raw)
                or OUTPUT_LIMIT_MESSAGE in raw)


THINKING_DISABLED_MESSAGE = "该模型不支持关闭思考；请在模型高级设置把“思考能力”改为“始终开启”后重试"
THINKING_DISABLED_RE = re.compile(
    r"thinking(?:\.type| type)?[^.\n]{0,40}disabled[^.\n]{0,40}not supported", re.I)


def thinking_disabled_unsupported(value) -> bool:
    """Recognize a provider rejecting disabled thinking before leaking its payload."""
    return bool(THINKING_DISABLED_RE.search(str(value or "")[:16000]))


def billing_diagnostic(value) -> dict | None:
    """Keep only recognized billing codes, never provider text or arbitrary fields."""
    payload = value if isinstance(value, dict) else None
    if payload is None:
        try:
            raw = str(value or "")[:16000]
            payload = json.loads(raw[raw.index("{"):])
        except (ValueError, TypeError):
            return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error", payload)
    if not isinstance(error, dict):
        return None
    code = str(error.get("code") or "")
    category = str(error.get("type") or "")
    if code == "1113":
        return {"code": "upstream_billing_error", "providerCode": "1113"}
    known = {"insufficient_quota", "insufficient_balance", "billing_hard_limit_reached",
             "billing_not_active", "upstream_billing_error"}
    if code in known or category in known:
        return {"code": "upstream_billing_error"}
    return None


def billing_message(diagnostic: dict) -> str:
    code = "；供应商错误码 1113" if diagnostic.get("providerCode") == "1113" else ""
    # The established SDK recognizes billing failures even when it retains only message.
    return ("模型服务余额不足或计费额度不可用（billing_required" + code +
            "），请检查供应商账单、API Key 类型和接口地址；重试不会恢复额度")


def refusal_category(status: int, body: str) -> str:
    """Return an allowlisted log category without assuming every 429 is throttling."""
    if billing_diagnostic(body):
        return "billing"
    if status != 429:
        return "upstream_error"
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        payload = None
    error = payload.get("error", payload) if isinstance(payload, dict) else None
    if isinstance(error, dict) and any(error.get(field) in (
            "rate_limit_exceeded", "rate_limit_error") for field in ("code", "type")):
        return "rate_limit"
    return "unclassified_429"


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
            r"|\bstatus(?:[_ ]?code)?\s*[:=]?\s*([45]\d{2})\b"
            r"|rejected this request\s*\(([45]\d{2})\)", raw, re.I)
        if match:
            status = int(next(group for group in match.groups() if group))
    diagnostic = billing_diagnostic(payload)
    if diagnostic:
        return billing_message(diagnostic)
    suffix = f"（HTTP {status}）" if status else ""
    if status in (0, 400, 422) and output_limit_exceeded(raw):
        return OUTPUT_LIMIT_MESSAGE + suffix
    if status in (0, 400, 422) and thinking_disabled_unsupported(raw):
        return THINKING_DISABLED_MESSAGE + suffix
    if status == 404:
        return "模型服务地址或模型不存在" + suffix + "；请切换可用模型，或联系管理员核对服务地址与模型名称。"
    if status == 403:
        return "模型请求被拒绝" + suffix
    if status == 401:
        return "模型服务拒绝了当前凭据或模型权限" + suffix + "。个人服务请在「我的模型」检查个人 Key，企业服务请联系管理员核对模型授权。"
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
