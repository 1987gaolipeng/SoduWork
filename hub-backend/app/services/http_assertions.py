"""Standard-library HTTP business assertions shared by server verification and Runner deployment."""
from __future__ import annotations

import time
import re
import urllib.error
import urllib.request

_TIMEOUT = 15
_BODY_LIMIT = 20000
_VARIABLE = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")


def materialize(spec: dict, variables: dict | None = None) -> dict:
    """Expand the small, non-secret deployment context used by release assertions."""
    values = {str(key): str(value) for key, value in dict(variables or {}).items()}

    def expand(value) -> str:
        text = str(value or "")
        return _VARIABLE.sub(
            lambda match: values.get(match.group(1), match.group(0)), text)

    out = dict(spec or {})
    for key in ("url", "body", "contains", "notContains"):
        if key in out:
            out[key] = expand(out[key])
    if "headers" in out:
        out["headers"] = {
            str(key): expand(value)
            for key, value in dict(out.get("headers") or {}).items()
        }
    return out


def once(spec: dict) -> dict:
    """Execute one assertion directly, bypassing system proxies that may intercept internal
    requests.
    """
    name = str(spec.get("name") or spec.get("url") or "HTTP 断言")[:80]
    url = str(spec.get("url") or "").strip()
    if not url:
        return {"name": name, "ok": False, "detail": "没填地址"}
    want_status = int(spec.get("expectStatus") or 200)
    contains = str(spec.get("contains") or "")
    not_contains = str(spec.get("notContains") or "")
    method = str(spec.get("method") or "GET").upper()
    timeout = min(120, max(1, int(spec.get("timeoutSeconds") or _TIMEOUT)))
    data = str(spec.get("body") or "").encode("utf-8") if spec.get("body") else None
    headers = {str(k): str(v) for k, v in dict(spec.get("headers") or {}).items()}
    if data and not any(k.lower() == "content-type" for k in headers):
        headers["Content-Type"] = "application/json"
    if not any(k.lower() == "user-agent" for k in headers):
        headers["User-Agent"] = "soduwork-runtime/1"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        request = urllib.request.Request(
            url, data=data, headers=headers, method=method)
        with opener.open(request, timeout=timeout) as response:
            status = int(response.status)
            body = response.read(_BODY_LIMIT).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        try:
            body = exc.read(_BODY_LIMIT).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            body = ""
    except Exception as exc:  # noqa: BLE001
        return {"name": name, "ok": False,
                "detail": "打不通（%s）" % type(exc).__name__}
    if status != want_status:
        return {"name": name, "ok": False,
                "detail": "返回 %d，期望 %d" % (status, want_status)}
    if contains and contains not in body:
        return {"name": name, "ok": False,
                "detail": "响应里没有「%s」" % contains[:40]}
    if not_contains and not_contains in body:
        return {"name": name, "ok": False,
                "detail": "响应里出现了不该有的「%s」" % not_contains[:40]}
    facts = []
    if contains:
        facts.append("命中「%s」" % contains[:20])
    if not_contains:
        facts.append("没有「%s」" % not_contains[:20])
    return {"name": name, "ok": True,
            "detail": "%s → HTTP %d%s" % (
                method, status, ("，" + "、".join(facts)) if facts else "")}


def probe(spec: dict, sleep=time.sleep) -> dict:
    """Apply configured retries; without retries, make exactly one attempt."""
    tries = min(10, max(0, int(spec.get("retries") or 0))) + 1
    gap = min(60, max(1, int(spec.get("intervalSeconds") or 5)))
    last = {}
    for index in range(tries):
        last = once(spec)
        if last.get("ok"):
            if index:
                last["detail"] = "%s（等了 %d 秒）" % (
                    last.get("detail") or "", index * gap)
            return last
        if index + 1 < tries:
            sleep(gap)
    if tries > 1:
        last["detail"] = "%s；重试 %d 次都没过" % (
            last.get("detail") or "", tries - 1)
    return last
