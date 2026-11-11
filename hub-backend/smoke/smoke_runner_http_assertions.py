# -*- coding: utf-8 -*-
"""Real HTTP-service regression tests for Runner post-deployment business assertions."""
import json
import os
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = tempfile.mkdtemp(prefix="soduwork-runner-http-")
os.environ["SODUWORK_DATA_ROOT"] = ROOT

from app.services import runner_deploy  # noqa: E402

ok = fail = 0
flaky = {"left": 1}


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:200] if extra else ""))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, code, body):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/flaky" and flaky["left"]:
            flaky["left"] -= 1
            self.send(503, '{"state":"starting"}')
        elif self.path == "/flaky":
            self.send(200, '{"state":"ready","version":"v2"}')
        elif self.path == "/version":
            self.send(200, '{"state":"ready","version":"v2"}')
        elif self.path == "/error":
            self.send(500, '{"error":"known-safe-error"}')
        else:
            self.send(404, "{}")

    def do_POST(self):
        size = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(size).decode("utf-8") if size else ""
        if self.headers.get("Authorization") != "Bearer runner-secret":
            self.send(401, '{"error":"unauthorized"}')
            return
        self.send(200, json.dumps({"received": json.loads(body)}, ensure_ascii=False))


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
run_id = "runner-http-smoke"
runner_deploy._save({"id": run_id, "state": "running"})

try:
    passed, detail = runner_deploy._check({
        "type": "http", "name": "认证业务检查", "url": base + "/echo",
        "method": "POST", "headers": {"Authorization": "Bearer runner-secret"},
        "body": '{"id":7}', "contains": '"id": 7', "notContains": "traceback",
        "expectStatus": 200,
    }, ROOT, dict(os.environ), run_id)
    chk("Runner 真正执行 POST、请求头、请求体与内容断言",
        passed and "POST" in detail and "命中" in detail, detail)

    passed, detail = runner_deploy._check({
        "type": "http", "name": "错误正文可判定", "url": base + "/error",
        "expectStatus": 500, "contains": "known-safe-error",
    }, ROOT, dict(os.environ), run_id)
    chk("4xx/5xx 响应正文也参与断言", passed and "命中" in detail, detail)

    passed, detail = runner_deploy._check({
        "type": "http", "name": "固定发布版本", "url": base + "/version",
        "expectStatus": 200, "contains": "${DEPLOY_COMMIT_SHORT}",
    }, ROOT, dict(os.environ), run_id, {
        "DEPLOY_COMMIT": "v2-full-commit", "DEPLOY_COMMIT_SHORT": "v2"})
    chk("Runner 用本次提交展开版本断言",
        passed and "v2" in detail and "DEPLOY_COMMIT" not in detail, detail)

    passed, detail = runner_deploy._check({
        "type": "http", "name": "等待服务就绪", "url": base + "/flaky",
        "expectStatus": 200, "contains": '"version":"v2"',
        "retries": 2, "intervalSeconds": 1,
    }, ROOT, dict(os.environ), run_id)
    chk("Runner 按配置重试并留下等待时长", passed and "等了 1 秒" in detail, detail)

    passed, detail = runner_deploy._check({
        "type": "http", "name": "禁止旧版本", "url": base + "/flaky",
        "expectStatus": 200, "notContains": "v2",
    }, ROOT, dict(os.environ), run_id)
    chk("notContains 失败不会假绿", not passed and "不该有" in detail, detail)

    log = runner_deploy.status(run_id).get("log") or ""
    chk("日志只记检查事实，不泄露认证头和请求体",
        "runner-secret" not in log and '"id":7' not in log, log)

    secret_run = "runner-secret-proof"
    runner_deploy._save({"id": secret_run, "state": "running"})
    runner_deploy._REDACT[secret_run] = ["ultra-secret-value"]
    old_probe = runner_deploy.http_assertions.probe
    try:
        runner_deploy.http_assertions.probe = lambda _item: {
            "ok": False, "detail": "响应意外包含 ultra-secret-value",
        }
        passed, detail = runner_deploy._check({
            "type": "http", "name": "敏感响应", "url": base + "/version",
        }, ROOT, dict(os.environ), secret_run)
        chk("结构化检查证据与日志使用同一脱敏规则",
            not passed and "ultra-secret-value" not in detail and "***" in detail, detail)
    finally:
        runner_deploy.http_assertions.probe = old_probe
        runner_deploy._REDACT.pop(secret_run, None)

    snapshots, advances = runner_deploy.snapshots({}, 20)
    first_revs = dict(advances)
    runner_deploy._save({"id": secret_run, "state": "running", "stage": "check"})
    changed, changed_advances = runner_deploy.snapshots(first_revs, 20)
    chk("Runner 发布快照按保存水位增量上报，不在 0.5 秒通道重复发送",
        any(item.get("id") == secret_run and item.get("stage") == "check" for item in changed)
        and dict(changed_advances).get(secret_run, 0) > first_revs.get(secret_run, 0),
        (changed, changed_advances))

    old_prepare, old_run, old_check = runner_deploy._prepare, runner_deploy._run, runner_deploy._check
    try:
        runner_deploy._prepare = lambda *_args: ROOT
        runner_deploy._run = lambda _argv, _cwd, _env, _timeout, _rid, _label: (0, "ok")
        runner_deploy._check = lambda *_args, **_kwargs: (False, "HTTP 503，服务未就绪")
        failed_run = "runner-proof-smoke"
        runner_deploy._save({"id": failed_run, "state": "queued"})
        runner_deploy._worker({
            "runId": failed_run, "repoId": "repo", "environmentKey": "production",
            "argv": ["deploy"], "checks": [{"type": "http", "name": "首页可访问"}],
            "rollback": {"mode": "automatic", "argv": ["rollback"]},
            "secrets": [], "git": {},
        }, ROOT, [])
        proof = runner_deploy.status(failed_run)
        result = proof.get("result") or {}
        chk("失败的上线检查在自动回滚后仍保留，不被回滚结果覆盖",
            proof.get("state") == "rolled_back"
            and (result.get("checks") or [{}])[0].get("detail") == "HTTP 503，服务未就绪"
            and (result.get("checks") or [{}])[0].get("ok") is False
            and dict(result.get("rollback") or {}).get("ok") is True,
            proof)
    finally:
        runner_deploy._prepare, runner_deploy._run, runner_deploy._check = (
            old_prepare, old_run, old_check)
finally:
    server.shutdown()
    shutil.rmtree(ROOT, ignore_errors=True)

print("\nrunner HTTP assertions: %d passed, %d failed" % (ok, fail))
raise SystemExit(1 if fail else 0)
