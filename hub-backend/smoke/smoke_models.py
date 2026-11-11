# -*- coding: utf-8 -*-
"""Model catalog tests for seeded definitions, organization and personal credentials, custom
models, and dispatch resolution. Never expose plaintext keys; personal credentials take
precedence. Isolate test records and remove them afterward.
"""
import asyncio
import io
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode

sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import auth, models  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.services import device_auth, model_catalog as mc  # noqa: E402

ok = fail = 0
log = []
BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/") + "/api/v1"
CID = "u-smoke-models"
PID = "smoke-provider"
CPID = "custom-smoke-local"
SECRET = "soduwork-model-smoke-device-secret-000001"


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def call(method, path, token=None, body=None, device=None):
    # Live compatibility check follows the same revision contract as the UI.
    if method == "PUT" and isinstance(body, dict) and "expectedRevision" not in body:
        body = dict(body)
        if path == "/my-models" and any(k in body for k in ("providers", "models")):
            _, current = call("GET", "/my-models", device=device)
            body["expectedRevision"] = current["revision"]
        elif path.startswith("/admin/model-providers/") or path == "/admin/model-defs":
            _, current = call("GET", "/admin/model-catalog", token)
            is_provider = path.startswith("/admin/model-providers/")
            identifier = path.rsplit("/", 1)[-1] if is_provider else body["providerId"] + ":" + body["name"]
            rows = current["providers" if is_provider else "models"]
            body["expectedRevision"] = next((r["revision"] for r in rows if r["id"] == identifier), "new")
    if method == "DELETE" and path.startswith("/admin/model-providers/"):
        _, current = call("GET", "/admin/model-catalog", token)
        revision = next(r["revision"] for r in current["providers"] if r["id"] == path.rsplit("/", 1)[-1])
        path += "?" + urlencode({"expectedRevision": revision})
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    if device:
        req.add_header("X-Soduwork-Device", device)
        req.add_header("X-Soduwork-Secret", SECRET)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


async def purge():
    async with SessionLocal() as s:
        for m in (await s.execute(select(models.ModelDef).where(
                models.ModelDef.provider_id == PID))).scalars().all():
            await s.delete(m)
        p = await s.get(models.ModelProvider, PID)
        if p is not None:
            await s.delete(p)
        c = await s.get(models.Client, CID)
        if c is not None:
            await s.delete(c)
        await s.commit()


async def main():
    await purge()
    async with SessionLocal() as s:
        # Select a real super administrator explicitly instead of relying on unordered first-row selection.
        u = (await s.execute(select(models.User).where(
            models.User.is_active.is_(True), models.User.is_super.is_(True)))).scalars().first()
        token = auth.sign_token(u.id)
        legacy_rows = list((await s.execute(select(models.AppSetting).where(
            models.AppSetting.key.in_(["llm_base_url", "llm_api_key"])
        ))).scalars().all())
        legacy = {row.key: row.value or "" for row in legacy_rows}
        c = models.Client(id=CID, secret_hash=device_auth.hash_secret(SECRET),
                          auth_state="active", user_ref=u.id)
        s.add(c)
        await s.commit()

    # Verify built-in catalog seeding.
    st, cat = call("GET", "/admin/model-catalog", token)
    chk("GET /model-catalog 通", st == 200, (st, str(cat)[:150]))
    pids = {p["id"] for p in cat.get("providers", [])}
    chk("★内置 provider 都在（共享模型服务/通用档/国内/国外）",
        {"company", "openai-compat", "deepseek", "aliyun", "zhipu", "moonshot",
         "openai", "anthropic", "google"} <= pids, sorted(pids))
    chk("★内置的一律不回显密钥（只说配没配）",
        all("apiKey" not in p for p in cat["providers"]), "有 provider 回了 apiKey")
    comp = next(p for p in cat["providers"] if p["id"] == "company")
    migrated = bool(legacy.get("llm_base_url") and legacy.get("llm_api_key"))
    chk("旧全局模型配置存在时迁入 company；干净安装不伪造地址和密钥",
        (comp["baseUrl"].startswith("http") and comp["keySet"])
        if migrated else (not comp["baseUrl"] and not comp["keySet"]), comp)
    chk("内置模型也种进来了", any(m["providerId"] == "deepseek" for m in cat["models"]),
        [m["id"] for m in cat["models"]][:8])
    chk("★内置项标了 builtin（界面据此禁掉删除）",
        all(p["builtin"] for p in cat["providers"] if p["id"] in ("company", "deepseek")), comp)

    # Add a provider and model without duplicating provider credentials on the model.
    st, _ = call("PUT", "/admin/model-providers/" + PID, token,
                 {"name": "（冒烟）自建网关", "baseUrl": "https://smoke.example.com/v1",
                  "apiKey": "org-key-123456", "enabled": True})
    chk("建 provider 通", st == 200, st)
    st, r = call("PUT", "/admin/model-defs", token,
                 {"providerId": PID, "name": "smoke-model-a", "label": "冒烟模型 A"})
    chk("★加模型只填了名字（没填 key）也成功", st == 200 and r.get("id") == PID + ":smoke-model-a", (st, r))
    st, _ = call("PUT", "/admin/model-providers/" + PID, token, {"baseUrl": "not-a-url"})
    chk("地址不合法被拦住", st == 400, st)

    # Inspect a client without personal settings.
    st, mine = call("GET", "/my-models", device=CID)
    chk("GET /my-models 通（首见自动注册这台 SoduWork）", st == 200, (st, str(mine)[:150]))
    chk("★这台能用的模型里有刚加的（走**组织**那把 key）",
        any(m["name"] == "smoke-model-a" and m["keyFrom"] == "org" for m in mine["usable"]),
        [(m["name"], m.get("keyFrom")) for m in mine["usable"]][:8])
    chk("★个人密钥也不回显", all("apiKey" not in p for p in mine["providers"]))

    # Use personal credentials when configured.
    st, r = call("PUT", "/my-models", body={"keys": {PID: "my-own-key-abcdef"}}, device=CID)
    chk("存个人密钥通", st == 200, st)
    chk("★配了个人 key → keyFrom 变成 mine（走自己的额度）",
        any(m["name"] == "smoke-model-a" and m["keyFrom"] == "mine" for m in r["usable"]),
        [(m["name"], m.get("keyFrom")) for m in r["usable"]][:8])
    st, mine2 = call("GET", "/my-models", device=CID)
    p2 = next(p for p in mine2["providers"] if p["id"] == PID)
    chk("★回的是「配了几位」而不是密钥本身",
        p2["myKeySet"] and p2["myKeyLen"] == len("my-own-key-abcdef") and "apiKey" not in p2, p2)

    # Verify which credentials dispatch resolves.
    async with SessionLocal() as s:
        c = await s.get(models.Client, CID)
        got = await mc.resolve(s, c, "smoke-model-a")
    chk("★resolve 拿到的是**个人**那把 key", got.get("key") == "my-own-key-abcdef",
        {k: v for k, v in got.items() if k != "key"})
    chk("resolve 带上了地址与模型名",
        got.get("base") == "https://smoke.example.com/v1" and got.get("model") == "smoke-model-a", got)

    # Explicit null removes the personal key and restores organization fallback.
    st, r = call("PUT", "/my-models", body={"keys": {PID: None}}, device=CID)
    async with SessionLocal() as s:
        c = await s.get(models.Client, CID)
        got2 = await mc.resolve(s, c, "smoke-model-a")
    chk("★删掉个人 key → 回落到组织那把", got2.get("key") == "org-key-123456",
        {k: v for k, v in got2.items() if k != "key"})

    # Create a personal custom model.
    st, r = call("PUT", "/my-models",
                 body={"models": [{"providerId": PID, "name": "my-private-model", "label": "我自己的"}]},
                 device=CID)
    chk("★个人自定义模型能用（组织清单里没有它）",
        any(m["name"] == "my-private-model" and m["own"] for m in r["usable"]),
        [(m["name"], m.get("own")) for m in r["usable"]][:8])

    # Override a provider endpoint and add a personal local unauthenticated service.
    st, r = call("PUT", "/my-models", body={
        "providers": [
            {"id": PID, "baseUrl": "https://mine.example.com/v1"},
            {"id": CPID, "name": "我的 Ollama", "kind": "openai-compat",
             "baseUrl": "http://127.0.0.1:11434/v1", "authMode": "none", "personal": True},
        ],
        "models": [
            {"providerId": PID, "name": "my-private-model", "label": "我自己的"},
            {"providerId": CPID, "name": "qwen-local", "label": "本地通义"},
        ],
    }, device=CID)
    chk("★个人能新增任意 OpenAI 兼容模型服务",
        st == 200 and any(m["providerId"] == CPID for m in r["usable"]), (st, r))
    st, mine3 = call("GET", "/my-models", device=CID)
    cp = next((p for p in mine3.get("providers", []) if p["id"] == CPID), {})
    chk("个人服务完整回显非敏感连接信息",
        cp.get("personal") and cp.get("authMode") == "none" and cp.get("baseUrl", "").endswith("/v1"), cp)
    async with SessionLocal() as s:
        c = await s.get(models.Client, CID)
        local = await mc.resolve(s, c, "qwen-local")
        overridden = await mc.resolve(s, c, "smoke-model-a")
    chk("★本地免密模型可解析给执行器", local.get("base") == "http://127.0.0.1:11434/v1"
        and local.get("keyFrom") == "none", {k: v for k, v in local.items() if k != "key"})
    chk("★覆盖组织地址后不把组织密钥发往个人网关", overridden == {}, overridden)
    st, _ = call("PUT", "/my-models", body={"keys": {"anthropic": "smoke-anthropic-key"}}, device=CID)
    async with SessionLocal() as s:
        c = await s.get(models.Client, CID)
        native = await mc.resolve(s, c, "claude-sonnet-4-5")
    chk("★Anthropic 原生协议随模型解析到执行器", st == 200 and native.get("kind") == "anthropic",
        {k: v for k, v in native.items() if k != "key"})

    # Disabling a provider immediately disables its models.
    call("PUT", "/admin/model-providers/" + PID, token, {"enabled": False})
    async with SessionLocal() as s:
        c = await s.get(models.Client, CID)
        lst = await mc.usable(s, c)
    chk("★停用 provider → 它底下的模型一个都不出现",
        not any(m["providerId"] == PID for m in lst), [m["id"] for m in lst][:8])

    # Protect built-in entries from deletion.
    st, _ = call("DELETE", "/admin/model-providers/company", token)
    chk("内置 provider 删不掉（只能停用）", st == 400, st)

    await purge()
    st, cat2 = call("GET", "/admin/model-catalog", token)
    chk("★冒烟数据已清干净",
        not any(p["id"] == PID for p in cat2["providers"]),
        [p["id"] for p in cat2["providers"]])
    async with SessionLocal() as s:
        chk("★冒烟 SoduWork 也删了", await s.get(models.Client, CID) is None)


asyncio.run(main())
log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_models.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
