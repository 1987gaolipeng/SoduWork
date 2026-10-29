# -*- coding: utf-8 -*-
"""Live development-flow API tests against a running Hub. Use an existing super-administrator
identity without passwords, modify only selected test settings, and restore all global and
repository configuration afterward.
"""
import asyncio
import io
import json
import os
import sys

sys.path.insert(0, ".")

import httpx  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app import models  # noqa: E402
from app.auth import sign_token  # noqa: E402
from app.db import SessionLocal  # noqa: E402

BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/")
log = []
ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


async def main():
    async with SessionLocal() as s:
        u = (await s.execute(select(models.User).where(models.User.is_active.is_(True)))).scalars().first()
        repo = (await s.execute(select(models.Repo))).scalars().first()
        # Verify schema migration added the required column.
        chk("repo.dev_flow 列存在", hasattr(models.Repo, "dev_flow"))
        before_repo = dict(getattr(repo, "dev_flow", None) or {}) if repo else {}
        rid = repo.id if repo else ""
        rname = repo.name if repo else ""
    if u is None:
        chk("库里有可用账号", False, "没有 active 用户，接口层没法验")
        return
    h = {"Authorization": "Bearer " + sign_token(u.id)}

    # Connect directly to 127.0.0.1; system proxies can turn loopback requests into misleading 503 failures.
    async with httpx.AsyncClient(base_url=BASE, headers=h, timeout=20,
                                 trust_env=False) as c:
        # Read global defaults.
        r = await c.get("/api/v1/admin/dev-flow")
        chk("GET /dev-flow 200", r.status_code == 200, r.text)
        d = r.json() if r.status_code == 200 else {}
        before = dict(d.get("cfg") or {})
        chk("带上默认值与红线清单", bool(d.get("defaults")) and len(d.get("locked") or []) >= 5)
        chk("带上内置步骤骨架", len(d.get("defaultSteps") or []) >= 5, d.get("defaultSteps"))
        chk("带上预设模板库", len(d.get("presets") or []) >= 5)
        chk("带上探测到的执行环境", (d.get("env") or {}).get("os") in ("windows", "linux", "macos"), d.get("env"))
        chk("默认分支模板是 fix/{task}", (d.get("cfg") or {}).get("branch") == "fix/{task}", d.get("cfg"))

        # Reject invalid branch templates.
        r = await c.put("/api/v1/admin/dev-flow", json={"cfg": {"branch": "mybranch"}})
        chk("没有 {task} 的模板被 400 拦下", r.status_code == 400, r.text)
        chk("拦下时说清为什么", "任务号" in r.text)
        r = await c.put("/api/v1/admin/dev-flow", json={"cfg": {"screenshot": "sometimes"}})
        chk("乱填的截图口径被拦", r.status_code == 400, r.text)

        # Persist configuration and verify round-trip equality.
        newcfg = {"branch": "feature/{task}", "selftest": "npm run build",
                  "screenshot": "never", "extra": "冒烟写入，随后还原"}
        r = await c.put("/api/v1/admin/dev-flow", json={"cfg": newcfg})
        chk("PUT /dev-flow 200", r.status_code == 200, r.text)
        back = (await c.get("/api/v1/admin/dev-flow")).json()["cfg"]
        chk("存进去的四项都读得回来", all(back.get(k) == v for k, v in newcfg.items()), back)

        # Verify preview matches dispatched instructions.
        r = await c.post("/api/v1/admin/dev-flow/preview", json={})
        chk("POST /dev-flow/preview 200", r.status_code == 200, r.text)
        p = r.json()
        chk("预览分支用的是新模板", p.get("branch", "").startswith("feature/"), p.get("branch"))
        chk("预览正文里有配的自测命令", "npm run build" in p.get("text", ""))
        chk("预览正文里 never 生效", "不要启动 GUI 浏览器截图" in p.get("text", ""))
        chk("预览正文里红线还在", "force push" in p.get("text", ""))

        # Persist and render custom steps and merge requests while rejecting invalid settings.
        steps = [{"key": "a", "title": "先开 Draft MR", "detail": "从 `{base}` 切 `{work}` 后先开一个 Draft MR。"},
                 {"key": "b", "title": "再改代码", "detail": "小步提交，提交信息带 {task}。"}]
        r = await c.put("/api/v1/admin/dev-flow", json={"cfg": {**newcfg, "steps": steps, "mr": "required"}})
        chk("PUT 自定义步骤+必须建 MR 200", r.status_code == 200, r.text)
        pv = (await c.post("/api/v1/admin/dev-flow/preview", json={})).json()
        chk("正文按自定义步骤渲染", "1. **先开 Draft MR**" in pv.get("text", ""), pv.get("text", "")[:200])
        chk("必须建 MR 的口径出现", "没有 MR 这活不算交完" in pv.get("text", ""))
        chk("自定义步骤下红线仍在", "自己合进基线分支" in pv.get("text", ""))
        r = await c.put("/api/v1/admin/dev-flow", json={"cfg": {"steps": [{"title": "光有标题"}]}})
        chk("步骤没写要求被 400 拦下", r.status_code == 400, r.text)
        await c.put("/api/v1/admin/dev-flow", json={"cfg": newcfg})   # Restore this case before later assertions.

        # Store only supplied repository overrides and verify precedence.
        if rid:
            r = await c.put("/api/v1/admin/repos/" + rid, json={"devFlow": {"screenshot": "always"}})
            chk("PUT repo devFlow 200", r.status_code == 200, r.text)
            got = r.json().get("devFlow") or {}
            chk("只存填了的那一项（其余继承）", got == {"screenshot": "always"}, got)
            r = await c.post("/api/v1/admin/dev-flow/preview", json={"repoId": rid})
            pv = r.json()
            chk("工程覆盖后：截图口径变 always", "纯后端改动也要留" in pv.get("text", ""))
            chk("工程没配的项仍继承全局（自测命令）", "npm run build" in pv.get("text", ""))
            chk("工程没配的项仍继承全局（分支模板）", pv.get("branch", "").startswith("feature/"))
            # Reject invalid repository-level configuration too.
            r = await c.put("/api/v1/admin/repos/" + rid, json={"devFlow": {"branch": "nope"}})
            chk("工程层也拦坏模板", r.status_code == 400, r.text)

        # Restore original configuration after the live test.
        await c.put("/api/v1/admin/dev-flow", json={"cfg": before or {}})
        if rid:
            await c.put("/api/v1/admin/repos/" + rid, json={"devFlow": before_repo})
        fin = (await c.get("/api/v1/admin/dev-flow")).json()["cfg"]
        chk("全局默认已还原", fin.get("branch") == (before.get("branch") or "fix/{task}"), fin)
        if rid:
            rr = await c.get("/api/v1/admin/projects/%s/repos" % (repo.project_id if repo else ""))
            cur = next((x for x in rr.json() if x["id"] == rid), {})
            chk("工程「%s」的覆盖已还原" % rname, (cur.get("devFlow") or {}) == before_repo, cur.get("devFlow"))

    log.append("")
    log.append("PASS=%d FAIL=%d" % (ok, fail))
    with io.open("smoke_devflow_api.out.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(log))
    print("PASS=%d FAIL=%d" % (ok, fail))
    print(json.dumps({"before_global": before, "before_repo": before_repo}, ensure_ascii=False))


asyncio.run(main())
sys.exit(1 if fail else 0)
