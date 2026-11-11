# -*- coding: utf-8 -*-
"""Opt-in live HTTP AI-proxy smoke test requiring SODUWORK_SMOKE_LIVE_AI=1, valid device identity, and
a running Hub. Verify scoped short-lived tickets, model visibility, real completion, incremental
streaming, explicit unavailable-model rejection, invalid-ticket rejection, and Responses API
forwarding. Calls consume real model usage.
"""
import atexit
import asyncio
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

ok = fail = 0
lines = []
_TEMP_CID = "u-smoke-ai-proxy-live"
_TEMP_SECRET = "smoke-ai-proxy-device-secret-0123456789abcdef"
_TEMP_CREATED = False
_DB_LOOP = asyncio.new_event_loop()


async def _seed_temp_identity() -> None:
    global _TEMP_CREATED
    from sqlalchemy import delete

    from app import models
    from app.db import SessionLocal
    from live_test_support import seed_active_device
    async with SessionLocal() as session:
        await session.execute(delete(models.Client).where(models.Client.id == _TEMP_CID))
        await seed_active_device(
            session, _TEMP_CID, _TEMP_SECRET, name="（冒烟）AI 代理",
            platform="live-smoke", app_version="live-gate")
        await session.commit()
    _TEMP_CREATED = True


async def _purge_temp_identity() -> None:
    global _TEMP_CREATED
    if not _TEMP_CREATED:
        return
    from sqlalchemy import delete

    from app import models
    from app.db import SessionLocal, engine
    try:
        async with SessionLocal() as session:
            await session.execute(delete(models.Client).where(models.Client.id == _TEMP_CID))
            await session.commit()
    finally:
        await engine.dispose()
    _TEMP_CREATED = False


def _purge_temp_identity_at_exit() -> None:
    try:
        if _TEMP_CREATED:
            _DB_LOOP.run_until_complete(_purge_temp_identity())
    except Exception as exc:  # noqa: BLE001
        print("Live AI smoke identity cleanup failed: %s: %s" %
              (type(exc).__name__, str(exc)[:180]), file=sys.stderr)
    finally:
        if not _DB_LOOP.is_closed():
            _DB_LOOP.close()


atexit.register(_purge_temp_identity_at_exit)


def _finish(code: int) -> int:
    """Normal exits must prove the live-only device was removed."""
    try:
        if _TEMP_CREATED:
            _DB_LOOP.run_until_complete(_purge_temp_identity())
    except Exception as exc:  # noqa: BLE001 - cleanup failure must fail the gate
        print("Live AI smoke identity cleanup failed: %s: %s" %
              (type(exc).__name__, str(exc)[:180]), file=sys.stderr)
        code = 1
    if _TEMP_CREATED:
        code = 1
    else:
        atexit.unregister(_purge_temp_identity_at_exit)
        if not _DB_LOOP.is_closed():
            _DB_LOOP.close()
    return int(code)


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def identity():
    hub = os.environ.get("SODUWORK_HUB", "") or os.environ.get("SMOKE_BASE", "")
    dev = os.environ.get("SODUWORK_DEVICE", "")
    sec = os.environ.get("SODUWORK_SECRET", "")
    if not (hub and dev and sec):
        p = os.path.join(os.environ.get("APPDATA", ""), "soduwork", "runner", "config.json")
        try:
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
            hub = hub or d.get("hub") or ""
            dev = dev or d.get("clientId") or ""
            sec = sec or d.get("secret") or ""
        except Exception as e:  # noqa: BLE001
            if not hub:
                print("读不到设备身份：%s（%s）" % (p, type(e).__name__))
                sys.exit(2)
    if hub and not (dev and sec):
        _DB_LOOP.run_until_complete(_seed_temp_identity())
        dev, sec = _TEMP_CID, _TEMP_SECRET
    if not (hub and dev and sec):
        print("缺少可用的 Hub 或设备身份")
        sys.exit(2)
    return hub.rstrip("/"), dev, sec


if not os.environ.get("SODUWORK_SMOKE_LIVE_AI"):
    print("跳过：这份要真打模型网关、真花 token。要跑就显式加 SODUWORK_SMOKE_LIVE_AI=1")
    sys.exit(0)

HUB, DEV, SEC = identity()
DEVICE_BEARER = DEV + ":" + SEC

# Require the model to join two marker halves so prompt echo cannot satisfy the assertion.
# Use alphanumeric halves only.
# Avoid punctuation that models may normalize while preserving the intended answer.
_P1, _P2 = "SODUWORK", "PROXY9"
TOKEN = _P1 + _P2
PROMPT = "把 %s 和 %s 直接拼成一个词，只输出这个词，不要空格、不要标点、不要解释。" % (_P1, _P2)
# Allow enough generation budget for reasoning models to return final content.
# An undersized budget can exhaust on reasoning before any answer appears.
# Do not mistake that artificial limit for a broken proxy.
# Keep the test prompt minimal.
# This test verifies transport, not extended model reasoning.
MAX_TOKENS = 2000


def _opener():
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        urllib.request.ProxyHandler({}),
    )


def call(path, body=None, headers=None, timeout=120, raw=False):
    """Return status and response text or object, treating HTTP errors as inspectable results."""
    req = urllib.request.Request(HUB + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode("utf-8") if body is not None else None)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        resp = _opener().open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, "%s: %s" % (type(e).__name__, e)
    if raw:
        return resp.status, resp
    with resp:
        return resp.status, resp.read().decode("utf-8", "replace")


print("后台 %s ／ 设备 %s" % (HUB, DEV))
chk("口令不是递过去的（提示词里凑不出 %s）" % TOKEN, TOKEN not in PROMPT)

# ---------------------------------------------------------------- ① /config
st, txt = call("/api/v1/ai-proxy/config", headers={"X-Soduwork-Device": DEV, "X-Soduwork-Secret": SEC})
cfg = json.loads(txt) if st == 200 else {}
chk("/config 200", st == 200, txt)
chk("/config 说得出用哪个模型", bool(cfg.get("ok") and cfg.get("model")), txt[:300])
chk("/config 给的地址是后端自己的出口", (cfg.get("path") or "").startswith("/api/v1/ai-proxy"), cfg.get("path"))
PROXY_TICKET = str(cfg.get("key") or "")
TICKET_TTL = int(cfg.get("expiresIn") or 0)
chk("★只回用途隔离的短期票据，不回设备密钥或网关密钥",
    bool(PROXY_TICKET) and PROXY_TICKET != DEVICE_BEARER and SEC not in PROXY_TICKET
    and 0 < TICKET_TTL <= 12 * 60 * 60, "keyLen=%d ttl=%d" % (len(PROXY_TICKET), TICKET_TTL))
MODEL = cfg.get("model") or ""
print("  → 模型 %s（%s，额度来自 %s）" % (MODEL, cfg.get("providerName"), cfg.get("keyFrom")))

if not MODEL:
    print("\n".join(lines))
    print("没有可用模型，后面几条没法测（先去「我的模型」配一把密钥）")
    raise SystemExit(_finish(1))

BASE = "/api/v1/ai-proxy/v1"
AUTH = {"Authorization": "Bearer " + PROXY_TICKET}

# ---------------------------------------------------------------- ② /v1/models
st, txt = call(BASE + "/models", headers=AUTH)
lst = (json.loads(txt).get("data") if st == 200 else []) or []
chk("/v1/models 200", st == 200, txt[:200])
chk("/v1/models 列出了默认模型", any(m.get("id") == MODEL for m in lst), [m.get("id") for m in lst][:8])

# Verify nonstreaming completion.
st, txt = call(BASE + "/chat/completions", {
    "model": MODEL, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": MAX_TOKENS,
}, headers=AUTH)
say = ""
try:
    say = (json.loads(txt).get("choices") or [{}])[0].get("message", {}).get("content") or ""
except Exception:  # noqa: BLE001
    pass
chk("非流式 200", st == 200, txt[:300])
chk("★模型真答了（回答里拼出了口令）", TOKEN in say.replace(" ", ""), say[:200] or txt[:200])

# Verify native Responses API forwarding for Codex Harness.
st, txt = call(BASE + "/responses", {
    "model": MODEL, "input": PROMPT, "max_output_tokens": MAX_TOKENS,
}, headers=AUTH)
response_text = ""
try:
    for item in json.loads(txt).get("output") or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if content.get("type") == "output_text":
                response_text += str(content.get("text") or "")
except Exception:  # noqa: BLE001
    pass
chk("Codex Harness Responses 非流式 200", st == 200, txt[:300])
chk("★Responses 模型真答了（回答里拼出了口令）",
    TOKEN in response_text.replace(" ", ""), response_text[:200] or txt[:200])

# Verify incremental streaming.
st, resp = call(BASE + "/chat/completions", {
    "model": MODEL, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": MAX_TOKENS,
    "stream": True,
}, headers=AUTH, raw=True)
# Count all streamed deltas when testing transport timing, including reasoning fragments.
# Use only final-content text for the response-marker assertion.
chunks, got, t0, t_first, t_last = 0, "", time.time(), None, None
done = False
if st == 200 and not isinstance(resp, str):
    with resp:
        while True:
            line = resp.readline(65536)
            if not line:
                break
            s = line.decode("utf-8", "replace").strip()
            if not s.startswith("data:"):
                continue
            payload = s[5:].strip()
            if payload == "[DONE]":
                done = True
                continue
            try:
                d = json.loads(payload)
            except Exception:  # noqa: BLE001
                continue
            delta = ((d.get("choices") or [{}])[0].get("delta") or {})
            piece = delta.get("content") or ""
            if piece or delta.get("reasoning_content"):
                chunks += 1
                got += piece
                t_first = t_first if t_first is not None else time.time()
                t_last = time.time()
chk("流式 200", st == 200, str(resp)[:200])
chk("★流式内容对（拼出了口令）", TOKEN in got.replace(" ", ""), got[:200])
chk("流式收尾有 [DONE]", done)
chk("★SSE 按多个增量分段返回（%d 段，首末相隔 %.3fs）" % (chunks, (t_last - t_first) if t_first else 0),
    chunks >= 2 and t_first is not None and t_last is not None,
    "chunks=%d 首字节 %.2fs" % (chunks, (t_first - t0) if t_first else -1))

# Reject an explicitly unavailable model.
st, txt = call(BASE + "/chat/completions", {
    "model": "gpt-9-not-mine", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1,
}, headers=AUTH)
chk("★用不了的模型当场拒（不静默换别的）", st == 400 and "gpt-9-not-mine" in txt, "%s %s" % (st, txt[:200]))

# Reject invalid credentials.
st, txt = call(BASE + "/chat/completions", {
    "model": MODEL, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1,
}, headers={"Authorization": "Bearer not-a-valid-ai-proxy-ticket"})
chk("伪造短期票据 401", st == 401, "%s %s" % (st, txt[:160]))

print("\n".join(lines))
print("PASS %d  FAIL %d" % (ok, fail))
raise SystemExit(_finish(1 if fail else 0))
