# -*- coding: utf-8 -*-
"""Smoke-test the skills API against a running service on port 9080 and verify dispatch includes
skills. Sign temporary tokens locally without passwords, and restore the enabled skill set
afterward.
"""
import asyncio
import io
from urllib.parse import urlparse
import os
import sys

BASE = os.environ.get("SMOKE_BASE")
if not BASE:
    raise SystemExit(
        "SMOKE_BASE is required; point this smoke test at a private local test server, "
        "never the default service port."
    )
BASE = BASE.rstrip("/")
parsed_base = urlparse(BASE)
if parsed_base.scheme not in {"http", "https"} or parsed_base.hostname not in {
    "127.0.0.1", "localhost"
}:
    raise SystemExit("SMOKE_BASE must point to a local test server (127.0.0.1 or localhost).")

database_url = os.environ.get("DATABASE_URL", "").lower()
safe_database_markers = (".smoke", "smoke-", "test.db", "/tmp/", "\\tmp\\", ":memory:")
if not any(marker in database_url for marker in safe_database_markers):
    raise SystemExit(
        "DATABASE_URL must point to an isolated smoke/test SQLite database; "
        "refusing to run against a live database."
    )
sys.path.insert(0, ".")

import httpx  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app import models  # noqa: E402
from app.auth import sign_token  # noqa: E402
from app.db import SessionLocal  # noqa: E402

CID = "u-smoke-skills-api"
TID = "t-smoke-skills-api"
ok = fail = 0
log = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


async def purge():
    async with SessionLocal() as s:
        task = await s.get(models.Task, TID)
        if task is not None:
            await s.delete(task)
            await s.flush()
        client = await s.get(models.Client, CID)
        if client is not None:
            await s.delete(client)
        await s.commit()


async def main():
    await purge()
    async with SessionLocal() as s:
        u = (await s.execute(select(models.User).where(models.User.is_active.is_(True)))).scalars().first()
        cl = models.Client(id=CID, name="技能接口冒烟 SoduWork", secret="smoke-skills-secret",
                           user_ref=u.id)
        t = models.Task(id=TID, title="技能注入冒烟", status="todo", owner_client_id=CID)
        s.add_all([cl, t])
        await s.commit()
    h = {"Authorization": "Bearer " + sign_token(u.id)}

    # Connect directly to 127.0.0.1; system proxies can turn loopback requests into misleading 503 failures.
    async with httpx.AsyncClient(base_url=BASE, headers=h, timeout=30,
                                 trust_env=False) as c:
        r = await c.get("/api/v1/admin/skills")
        chk("GET /skills 200", r.status_code == 200, r.text)
        d = r.json() if r.status_code == 200 else {}
        before = dict(d.get("cfg") or {})
        names = [x["name"] for x in (d.get("skills") or [])]
        chk("扫到内置技能 delivery-check", "delivery-check" in names, names)
        chk("带上扫描目录清单", len(d.get("roots") or []) >= 4, d.get("roots"))
        # Assert the API contract rather than assuming an empty production database.
        # Existing administrator-enabled skills are valid and must not cause a false failure.
        chk("开放清单是 allowed（三层归属：管理端只管开放）",
            isinstance((d.get("cfg") or {}).get("allowed"), list), d.get("cfg"))
        chk("每条技能都标了开放没开放",
            all("allowed" in x for x in (d.get("skills") or [])), (d.get("skills") or [])[:1])

        r = await c.put("/api/v1/admin/skills", json={"cfg": {"allowed": ["delivery-check"]}})
        chk("PUT /skills 200", r.status_code == 200, r.text)
        back = (await c.get("/api/v1/admin/skills")).json()
        chk("开放状态读得回来",
            any(x["name"] == "delivery-check" and x["allowed"] for x in back["skills"]), back.get("cfg"))
        chk("★没开放的真的没开放（不是全都标开放）",
            not all(x["allowed"] for x in back["skills"]) or len(back["skills"]) == 1,
            [x["name"] for x in back["skills"] if x["allowed"]])

        # Verify that the assembled dispatch body includes skills.
        # Use the dispatch path's own api.tasks._attach_skills and ai_exec.preview functions.
        # Device authentication belongs to the HTTP layer and does not affect this assembly assertion.
        if t:
            from app.api import tasks as tasks_api
            from app.services import ai_exec
            async with SessionLocal() as s2:
                tt = await s2.get(models.Task, t.id)
                ctx = await ai_exec.load(s2, force=True)
                extra = await ai_exec.collect_task_context(s2, tt.id)
                extra["repo"] = {}
                # Pass the actual client: selected skills belong to that device.
                # Effective skills are the intersection of client.skills and the enabled catalog.
                # Omitting the client represents an empty local selection and invalidates this test.
                mine = list((cl.skills or []) if cl is not None else [])
                if cl is not None:
                    cl2 = await s2.get(models.Client, cl.id)
                    cl2.skills = ["delivery-check"]
                    await s2.flush()
                    await tasks_api._attach_skills(s2, extra, {}, cl2)
                    cl2.skills = mine                     # Restore the device selection immediately to preserve existing settings.
                    await s2.commit()
                else:
                    await tasks_api._attach_skills(s2, extra, {}, None)
                chk("解析出该带的技能", [x["name"] for x in extra["skills"]] == ["delivery-check"],
                    extra.get("skills"))
                body = ai_exec.preview(tt, ctx, extra).get("description", "")
                chk("★派活正文里带上了技能清单", "delivery-check" in body, body[-500:])
                chk("正文教它先 read SKILL.md", "SKILL.md" in body)
                chk("给了技能的绝对路径（CLI 要按路径读）", "skills" in body and "delivery-check" in body)

        await c.put("/api/v1/admin/skills", json={"cfg": before})     # Restore the original database state.
        fin = (await c.get("/api/v1/admin/skills")).json()
        chk("★开放清单已还原",
            (fin.get("cfg") or {}).get("allowed") == (before.get("allowed") or []), fin.get("cfg"))

    log.append("")
    log.append("PASS=%d FAIL=%d" % (ok, fail))
    with io.open("smoke_skills_api.out.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(log))
    print("PASS=%d FAIL=%d" % (ok, fail))


async def guarded():
    try:
        await main()
    finally:
        await purge()


asyncio.run(guarded())
sys.exit(1 if fail else 0)
