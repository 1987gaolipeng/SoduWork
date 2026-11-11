# -*- coding: utf-8 -*-
"""Test deployment business assertions against a real local HTTP server: target-configured checks,
response content including error bodies, methods/headers/bodies, explicit retries,
unsupported-command reporting, and visible zero-check evidence.
"""
import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

DB = os.path.abspath(".smoke-deploy-assert.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import deploy_verify, environment_service  # noqa: E402

ok = fail = 0
SHA = "e3283fb51c847407d50fcfde9f108c4a413cd2e0"
_FLAKY = {"left": 2}          # Return 503 twice before succeeding to simulate service readiness delay.


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):        # Suppress noisy access logging.
        pass

    def _send(self, code, body):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, json.dumps({
                "status": "UP", "version": "v0.1.33", "commit": SHA
            },
                                       ensure_ascii=False))
        elif self.path == "/flaky":
            if _FLAKY["left"] > 0:
                _FLAKY["left"] -= 1
                self._send(503, '{"msg":"starting"}')
            else:
                self._send(200, '{"status":"UP"}')
        elif self.path == "/broken":
            self._send(500, json.dumps({"error": "NullPointerException"}))
        else:
            self._send(404, "{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8") if n else ""
        if self.headers.get("Authorization") != "Bearer smoke-token":
            self._send(401, '{"error":"no token"}')
            return
        self._send(200, json.dumps({"echo": json.loads(body or "{}")}, ensure_ascii=False))


async def main():
    await init_db()
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % srv.server_port

    # Configure assertions on the deployment target.
    checks = environment_service._checks([
        {"type": "http", "name": "服务活着", "url": base + "/health",
         "contains": "UP"},
        {"type": "http", "name": "这次的版本真上线了", "url": base + "/health",
         "contains": "${DEPLOY_COMMIT_SHORT}", "notContains": "v0.1.32"},
        {"type": "http", "name": "带认证的业务接口", "url": base + "/echo", "method": "POST",
         "headers": {"Authorization": "Bearer smoke-token"}, "body": '{"id":1}',
         "contains": '"id": 1'},
        {"type": "http", "name": "刚发完还没起来", "url": base + "/flaky",
         "retries": 3, "intervalSeconds": 1},
        {"type": "command", "name": "在执行机上跑的检查", "argv": ["echo", "hi"]},
    ])
    chk("① 断言存得下新字段（方法/头/体/内容判定/重试）",
        checks[2]["method"] == "POST" and checks[2]["headers"]["Authorization"].startswith("Bearer")
        and checks[1]["notContains"] == "v0.1.32" and checks[3]["retries"] == 3, checks[2])
    chk("① 老字段没被动（只配 url 的那种照样能存）",
        checks[0]["expectStatus"] == 200 and checks[0]["timeoutSeconds"] == 15, checks[0])
    try:
        environment_service._checks([{"type": "http", "name": "x", "url": base, "method": "TRACE"}])
        chk("① 不认识的请求方法要拦住", False)
    except ValueError:
        chk("① 不认识的请求方法要拦住", True)

    async with SessionLocal() as s:
        s.add(models.Task(id="t1", title="发一版", status="doing", owner_client_id="c1"))
        s.add(am.Environment(id="env1", key="staging", name="预发环境",
                             health_checks=[checks[0]]))
        s.add(am.DeploymentTarget(id="tg1", repo_id="r1", environment_id="env1",
                                  name="生产数据分析 · 预发", provider="cicd-mcp",
                                  config={"customer": "示例客户", "environment": "预发环境"},
                                  health_checks=checks[1:]))
        await s.commit()

    class NR:                     # Minimal node fixture containing only fields used by verification.
        def __init__(self, deps):
            self.input = {"dependencies": deps}
            self.output = {}

    published = {"deployStatus": "SUCCESS", "artifactSha": SHA, "version": "jsai-dev-v0.1.33",
                 "customer": "示例客户", "targetId": "tg1", "environmentId": "env1"}
    merged = {"commit": SHA}

    async with SessionLocal() as s:
        task = await s.get(models.Task, "t1")
        nr = NR({"publish": published, "merge": merged})
        out = await deploy_verify.verify(s, task, nr, {"config": {}})
    names = {x["name"]: x for x in out["checks"]}
    chk("② 环境上配的那条也跑了（环境 + 部署入口合起来）", "服务活着" in names, list(names))
    chk("② 动态提交占位符展开后真的判了本次版本",
        names["这次的版本真上线了"]["ok"] is True
        and "e3283fb51c84" in names["这次的版本真上线了"]["detail"],
        names.get("这次的版本真上线了"))
    chk("② 带认证的 POST 打通了", names["带认证的业务接口"]["ok"] is True,
        names.get("带认证的业务接口"))
    chk("★② 刚发完没起来的，等到了就算过", names["刚发完还没起来"]["ok"] is True,
        names.get("刚发完还没起来"))
    chk("★② 等过就要说等了多久（不然看不出这条是熬过去的）",
        "等了" in str(names["刚发完还没起来"]["detail"]), names.get("刚发完还没起来"))
    chk("★② command 型明说跳过，不假装验过",
        out["skippedChecks"] == ["在执行机上跑的检查"], out.get("skippedChecks"))
    chk("② 验了几条业务断言要写在证据里", out["assertions"] == 4, out.get("assertions"))

    # A failed required assertion fails the verification gate.
    async with SessionLocal() as s:
        tg = await s.get(am.DeploymentTarget, "tg1")
        tg.health_checks = environment_service._checks([
            {"type": "http", "name": "关键接口不能报错", "url": base + "/broken",
             "expectStatus": 200},
            {"type": "http", "name": "响应里不许有堆栈", "url": base + "/broken",
             "expectStatus": 500, "notContains": "NullPointerException"},
        ])
        await s.commit()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t1")
        nr = NR({"publish": published, "merge": merged})
        try:
            await deploy_verify.verify(s, task, nr, {"config": {}})
            chk("③ 断言没过必须判这一关失败", False)
            saved = nr.output
        except ValueError as e:
            msg = str(e)
            saved = nr.output
            chk("③ 断言没过必须判这一关失败", True)
            chk("③ 话术点名是哪一条没过", "关键接口不能报错" in msg, msg[:160])
            chk("★③ 4xx/5xx 的正文也读得到（断言常冲着报错内容去）",
                "响应里不许有堆栈" in msg, msg[:200])
    chk("★③ 失败也把逐条证据落盘了（引擎回滚不该把证据一起抹掉）",
        len((saved or {}).get("checks") or []) >= 4, saved)

    # An empty assertion set remains visible in evidence.
    async with SessionLocal() as s:
        tg = await s.get(am.DeploymentTarget, "tg1")
        tg.health_checks = []
        env = await s.get(am.Environment, "env1")
        env.health_checks = []
        await s.commit()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t1")
        nr = NR({"publish": published, "merge": merged})
        out = await deploy_verify.verify(s, task, nr, {"config": {}})
    chk("★④ 没配业务断言时 assertions=0（绿了不等于验过了）",
        out["assertions"] == 0 and len(out["checks"]) == 2, out)

    srv.shutdown()
    print("\n%s  通过 %d / %d" % ("全绿" if not fail else "有红", ok, ok + fail))
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
