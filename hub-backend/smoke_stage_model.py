# -*- coding: utf-8 -*-
"""Verify stage model overrides using the real context shape rather than a flattened configuration.
Cover with_model, model_choices, _model_list, CLI propagation, and administrator configuration
persistence in disposable SQLite. Never connect to port 9080 or the business database; configure
isolation before importing app modules.
"""
import io
import os
import sys
import tempfile

_SMOKE_TMP = tempfile.TemporaryDirectory(prefix="soduwork-smoke-stage-model-")
_SMOKE_DB = os.path.join(_SMOKE_TMP.name, "smoke-stage-model.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + _SMOKE_DB.replace("\\", "/")
os.environ["DB_MIGRATION_MODE"] = "auto"
os.environ["REPORT_AUTO"] = "false"

sys.path.insert(0, ".")

ok = fail = 0
log = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


# Verify pure configuration functions.
from app.services import ai_exec, ai_local  # noqa: E402

# Retain a synthetic hosted context to verify with_model updates both cfg and localCfg.
REAL = {"name": "hosted-x",
        "cfg": {"hosted_base_url": "x"},
        "localCfg": {"llm": {"base": "b", "key": "k", "model": "原模型"}}}

out = ai_exec.with_model(REAL, "改成这个")
chk("★覆盖落在 localCfg.llm.model（本机那条真正会读的地方）",
    out["localCfg"]["llm"]["model"] == "改成这个", out)
chk("★原件一点没动（cfg 是每次派活现取的，改这份不许影响别的活）",
    REAL["localCfg"]["llm"]["model"] == "原模型", REAL)
chk("没有 llm 的那份不被硬塞（没网关地址塞了也起不来）",
    "llm" not in out["cfg"], out["cfg"])
chk("空模型 = 原样返回", ai_exec.with_model(REAL, "") is REAL)
chk("空白模型也算没配", ai_exec.with_model(REAL, "   ") is REAL)

LOCAL = {"name": "local", "cfg": {"llm": {"base": "b", "key": "k", "model": "M0"}}}
chk("provider 就是 local 时覆盖 cfg 那份",
    ai_exec.with_model(LOCAL, "M1")["cfg"]["llm"]["model"] == "M1")

chk("只配了默认 → 候选是空的（界面上就只有「跟默认」一枚片）",
    ai_exec.model_choices(LOCAL) == {"default": "M0", "list": []},
    ai_exec.model_choices(LOCAL))
L2 = {"name": "local", "cfg": {"llm": {"model": "M0", "models": ["M2", "M0", " ", "M2", "M3"]}}}
chk("★候选里去掉默认（不然两枚片长得一样、含义却不同）+ 去重 + 空项丢掉",
    ai_exec.model_choices(L2)["list"] == ["M2", "M3"], ai_exec.model_choices(L2))
chk("没配模型服务 → 空", ai_exec.model_choices({"name": "local", "cfg": {}}) ==
    {"default": "", "list": []})

# Verify the overridden model reaches the CLI arguments or environment.
# Selecting the right dispatch configuration alone does not prove CLI propagation.
from app.services import local_base as LB  # noqa: E402

_ov = ai_exec.with_model(LOCAL, "M-覆盖")["cfg"]
chk("★pi：覆盖后的模型写进了 --model",
    "--model" in LB._pi_args("sid-1", "work", _ov)
    and LB._pi_args("sid-1", "work", _ov)[LB._pi_args("sid-1", "work", _ov).index("--model") + 1] == "M-覆盖",
    LB._pi_args("sid-1", "work", _ov))
# Test the opencode profile through OPENCODE_CONFIG_CONTENT.
# Avoid the pi profile because it writes the user's ~/.pi/agent/models.json.
_env = LB._env_for(LB._PROFILES["opencode"], dict(_ov, llm=dict(_ov["llm"], base="https://x/v1", key="k")))
chk("★opencode：覆盖后的模型写进了注入的配置",
    '"model": "company/M-覆盖"' in _env.get("OPENCODE_CONFIG_CONTENT", ""),
    _env.get("OPENCODE_CONFIG_CONTENT", "")[:200])

chk("候选清单解析：正常 JSON", ai_local._model_list('["a","b"]') == ["a", "b"])
chk("候选清单解析：手工改坏了不炸", ai_local._model_list("{坏的") == [])
chk("候选清单解析：空", ai_local._model_list("") == [] and ai_local._model_list(None) == [])
chk("候选清单解析：不是数组也不炸", ai_local._model_list('{"a":1}') == [])

# Exercise administrator service functions against the temporary database.
import asyncio  # noqa: E402

from app import models  # noqa: E402
from app.api import admin  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402


async def main():
    await init_db()
    chk("模型冒烟明确运行在一次性临时库",
        os.path.abspath(_SMOKE_DB).startswith(os.path.abspath(_SMOKE_TMP.name)), _SMOKE_DB)
    async with SessionLocal() as s:
        u = models.User(username="stage-model-smoke", display_name="模型冒烟",
                        is_active=True, is_super=True)
        s.add(u)
        s.add_all([
            models.AppSetting(key="llm_base_url", value="https://smoke.invalid/v1"),
            models.AppSetting(key="llm_model", value="smoke-default"),
            models.AppSetting(key="llm_api_key", value="smoke-key-not-real"),
        ])
        await s.commit()

        cur = await admin.get_llm_config(session=s)
        chk("GET /llm-config 服务函数通", "models" in cur, cur)
        keep_base, keep_model = cur.get("baseUrl", ""), cur.get("model", "")

        saved = await admin.put_llm_config(
            {"expectedRevision": cur["revision"], "baseUrl": keep_base, "model": keep_model,
             "models": ["冒烟模型-A", "冒烟模型-B", "冒烟模型-A", "  "]},
            user=u, session=s)
        chk("PUT 候选清单通", saved.get("ok") is True, saved)
        back = await admin.get_llm_config(session=s)
        chk("★读回来就是刚写的（去重 + 空项丢掉）",
            back.get("models") == ["冒烟模型-A", "冒烟模型-B"], back.get("models"))
        chk("密钥仍然只回是否已配，绝不回明文",
            "apiKey" not in back and "keySet" in back, back)

        # Legacy callers that omit models must preserve the existing list.
        await admin.put_llm_config(
            {"expectedRevision": back["revision"], "baseUrl": keep_base, "model": keep_model}, user=u, session=s)
        back2 = await admin.get_llm_config(session=s)
        chk("★老调用方不传 models → 保持原样，不被清空",
            back2.get("models") == ["冒烟模型-A", "冒烟模型-B"], back2.get("models"))

        # Dispatch must read the same model list as the API from the temporary database.
        ctx = await ai_exec.load(s, force=True)
        mc = ai_exec.model_choices(ctx)
        chk("★派活链上取到的候选里有刚写的",
            "冒烟模型-A" in mc["list"], mc)
    await engine.dispose()


try:
    asyncio.run(main())
finally:
    _SMOKE_TMP.cleanup()
log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_stage_model.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
