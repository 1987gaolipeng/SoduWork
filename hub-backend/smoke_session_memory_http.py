"""Isolated real HTTP + migrations: private Codex session imports and explicit recall."""
from __future__ import annotations
import asyncio
import json
import os
import tempfile

_root = tempfile.TemporaryDirectory(prefix="soduwork-smoke-session-memory-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + os.path.join(_root.name, "memory.db").replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = os.path.join(_root.name, "data")
os.environ["DB_MIGRATION_MODE"] = "auto"
os.environ["REPORT_AUTO"] = "false"
os.environ["POLL_INTERVAL_SECONDS"] = "0"

import httpx
from sqlalchemy import select, func
from app import models
from app.db import SessionLocal, engine, init_db
from app.main import app
from app.services import device_auth
from app.session_memory_models import SessionMemory

tokens = {}
checks = []
def check(name, result):
    assert result, name
    checks.append(name)
    print("PASS " + name)

async def seed():
    async with SessionLocal() as s:
        s.add_all([models.OrgUnit(id="org-a", name="部门 A"), models.OrgUnit(id="org-b", name="部门 B")])
        one = models.User(id="user-one", username="memory-one", org_id="org-a", is_active=True)
        two = models.User(id="user-two", username="memory-two", org_id="org-b", is_active=True)
        s.add_all([one, two])
        for cid, user in [("device-one", one), ("device-two", two), ("device-three", one)]:
            client = models.Client(id=cid, name=cid, secret_hash=device_auth.hash_secret("isolated-fixture"))
            device_auth.activate(client, user)
            s.add(client)
            tokens[cid] = device_auth.issue_session(client)[0]
        s.add_all([models.Project(id="p-one", name="项目一", org_id="org-a"),
                   models.Project(id="p-two", name="项目二", org_id="org-b"),
                   models.Repo(id="r-one", project_id="p-one", name="前端"),
                   models.Repo(id="r-two", project_id="p-two", name="后台"),
                   models.Task(id="task-one", owner_client_id="device-one", created_by="user-one",
                               title="测试导入", project_id="p-one", repo_id="r-one"),
                   models.Task(id="task-two", owner_client_id="device-two", created_by="user-two",
                               title="另一个用户", project_id="p-two", repo_id="r-two")])
        await s.commit()

BASE = "/api/v1/session-memories"
def body(**patch):
    return {"title": "Codex 工作上下文", "fields": {"summary": "经确认的摘要", "pending": "补齐回归"},
            "source": "codex", "sourceSessionId": "codex-source-one", "sourceHash": "a" * 64,
            "events": [{"role": "user", "text": "USER-EVIDENCE"},
                       {"role": "tool", "text": "TOOL-ONLY", "callId": "call-one"}],
            "warnings": [], "sourceMeta": {"fileName": "rollout.jsonl", "format": "jsonl", "retained": 2}, "confirmed": True, **patch}

async def main():
    await init_db()
    await init_db()
    await seed()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client:
        async def req(method, route="", payload=None, who="device-one"):
            return await client.request(method, BASE + route, json=payload,
                headers={"Authorization": "Device " + tokens[who]} if who else {})
        check("authentication required", (await req("GET", who="")).status_code == 401)
        opts = (await req("GET", "/options")).json()
        check("association options obey project and task permissions",
              [p["id"] for p in opts["projects"]] == ["p-one"] and [t["id"] for t in opts["tasks"]] == ["task-one"])
        check("no import without explicit confirmation", (await req("POST", payload=body(confirmed=False))).status_code == 422)
        check("reject hidden instructions as roles", (await req("POST", payload=body(events=[{"role":"system","text":"bad"}]))).status_code == 422)
        check("reject blank title", (await req("POST", payload=body(title=" "))).status_code == 422)
        check("reject unauthorized project", (await req("POST", payload=body(projectId="p-two"))).status_code == 404)
        check("reject mismatched task and repo", (await req("POST", payload=body(taskId="task-one",repoId="r-two"))).status_code == 422)
        check("reject other user's task", (await req("POST", payload=body(taskId="task-two"))).status_code == 404)
        response = await req("POST", payload=body(taskId="task-one"))
        check("create durable private import", response.status_code == 200)
        item = response.json()["item"]
        check("import preserves safe provenance", item["sourceMeta"]["fileName"] == "rollout.jsonl" and item["scope"] == "private" and item["sourceMeta"]["security"]["commandsExecuted"] is False)
        mid = item["id"]
        check("task resolves its project and Git repo", (item["projectId"], item["repoId"]) == ("p-one", "r-one"))
        check("repeat import is idempotent", (await req("POST", payload=body(taskId="task-one"))).json()["duplicate"])
        check("same user on another device sees own import", (await req("GET", "/" + mid, who="device-three")).status_code == 200)
        check("another account cannot read", (await req("GET", "/" + mid, who="device-two")).status_code == 404)
        check("another account cannot recall", (await req("POST", "/context", {"ids":[mid]}, who="device-two")).status_code == 404)
        check("another account cannot delete", (await req("DELETE", "/" + mid, who="device-two")).status_code == 404)
        check("another account cannot list", not (await req("GET", who="device-two")).json()["items"])
        context = (await req("POST", "/context", {"ids":[mid]})).json()
        check("recall uses confirmed fields, excludes raw evidence",
              "经确认的摘要" in context["prompt"] and "TOOL-ONLY" not in context["prompt"] and "USER-EVIDENCE" not in context["prompt"])
        check("recall carries source and revision", context["items"][0]["revision"] == 1 and context["items"][0]["id"] == mid)
        check("recall size guard", (await req("POST", "/context", {"ids":[mid]*4})).status_code == 422)
        edit = {"title":"修改后的标题", "fields":{"summary":"修改后的摘要", "constraints":"api_key=\"DO-NOT-STORE\"\nhttps://x.invalid/?token=DO-NOT-STORE"},
                "projectId":"p-one", "repoId":"r-one", "taskId":"task-one", "confirmed":True, "revision":1}
        changed = (await req("PUT", "/" + mid, edit)).json()
        check("edit advances revision", changed["item"]["revision"] == 2)
        check("server also redacts sensitive data", "DO-NOT-STORE" not in json.dumps(changed))
        check("stale edit rejected", (await req("PUT", "/" + mid, edit)).status_code == 409)
        context = (await req("POST", "/context", {"ids":[mid]})).json()
        check("new use gets latest confirmed summary", "修改后的摘要" in context["prompt"])
        check("duplicate import never overwrites reviewed summary",
              (await req("POST", payload=body(taskId="task-one"))).json()["item"]["revision"] == 2)
        archived = await req("POST", "/" + mid + "/archive")
        check("archive is reversible", archived.status_code == 200 and archived.json()["item"]["archived"])
        check("archived memory leaves default library", not (await req("GET")).json()["items"])
        check("archived memory can be listed explicitly", (await req("GET", "?archived=true")).json()["items"][0]["id"] == mid)
        check("archived memory cannot be recalled until restored", (await req("POST", "/context", {"ids":[mid]})).status_code == 404)
        restored = await req("POST", "/" + mid + "/restore")
        check("restore returns memory to library", restored.status_code == 200 and not restored.json()["item"]["archived"])
        check("search is literal", not (await req("GET", "?search=%25")).json()["items"])
        async with SessionLocal() as s:
            project = await s.get(models.Project, "p-one")
            project.org_id = "org-b"
            await s.commit()
        check("access revocation prevents future recall", (await req("POST", "/context", {"ids":[mid]})).status_code == 404)
        check("private evidence remains manageable after access revocation", (await req("GET", "/" + mid)).status_code == 200)
        check("owner can remove import", (await req("DELETE", "/" + mid)).status_code == 200)
        check("deleted memory cannot be recalled", (await req("POST", "/context", {"ids":[mid]})).status_code == 404)
        async with SessionLocal() as s:
            check("delete removes durable evidence", await s.scalar(select(func.count()).select_from(SessionMemory)) == 0)
        batch = await asyncio.gather(*(req("POST", payload=body()) for _ in range(3)))
        check("concurrent retries produce one import", all(r.status_code == 200 for r in batch)
              and len({r.json()["item"]["id"] for r in batch}) == 1)
    await engine.dispose()
    print(json.dumps({"ok":True, "checks":len(checks), "database":"isolated temporary SQLite"}, ensure_ascii=False))
    _root.cleanup()

if __name__ == "__main__":
    asyncio.run(main())
