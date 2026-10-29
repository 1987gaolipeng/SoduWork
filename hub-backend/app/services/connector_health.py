"""Reviewed connector health status; expose metadata only across remote boundaries, without
business data.
"""
from datetime import datetime, timezone
import json

STATES = {"configured", "verified", "needs_auth", "offline", "error"}
MESSAGES = {
    "configured": "配置与工具清单就绪；账号授权尚未验证",
    "verified": "账号授权已验证；具体资源与写入权限以实际操作为准",
    "needs_auth": "授权已失效或权限不足，请重新连接平台账号",
    "offline": "执行机不在线，请启动对应客户端或云端电脑",
    "error": "连接暂时无法验证，请检查配置、网络及执行机",
}


def result(state="configured", tested=False):
    state = state if state in STATES else "error"
    return {"ok": state in {"configured", "verified"}, "connectionState": state,
            "authenticationTested": bool(tested and state == "verified"),
            "checkedAt": datetime.now(timezone.utc).isoformat(), "message": MESSAGES[state],
            "verificationScope": "identity" if tested and state == "verified" else "configuration"}


def metadata(payload):
    state = payload.get("connectionState") or ("configured" if payload.get("ok", True) else "error")
    if state == "verified" and payload.get("authenticationTested") is not True:
        state = "configured"
    return result(state, payload.get("authenticationTested") is True)


def probe(spec, timeout):
    from . import mcp_servers
    if spec.get("command") not in {"soduwork-connector", "soduwork-api"}:
        return result()
    try:
        data = json.loads(mcp_servers._bridge_sync(spec["name"], spec, "health", timeout=timeout))
        return metadata(data if isinstance(data, dict) else {"ok": False})
    except Exception:
        # Do not forward subprocess output, tokens, or identity responses to callers.
        return result("error")
