# -*- coding: utf-8 -*-
"""End-to-end plugin import test on a disposable Hub: build a package, import to quarantine,
approve, bind, create a task, execute real tool nodes, and complete through engine lifecycle.
Use product HTTP throughout and never connect to business data.
"""
import contextlib
import io
import json
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import zipfile

sys.path.insert(0, ".")

HUB = ""
ADMIN_USER = ""
ADMIN_PASS = ""
CID = "u-smoke-pluge2e"
SECRET = "smoke-pluge2e-secret"
KEY = "smoke-authoring-demo"

ok = fail = 0
made = {"task": "", "plugin": "", "binding": ""}


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:280] if extra else ""))


def _req(method, path, body=None, headers=None, raw=None, ctype="application/json"):
    req = urllib.request.Request(HUB + "/api/v1" + path, method=method)
    req.add_header("Content-Type", ctype)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = raw if raw is not None else (
        json.dumps(body).encode("utf-8") if body is not None else None)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, data, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, {"detail": e.read().decode("utf-8", "replace")[:300]}


def _req_blob(path, headers=None):
    req = urllib.request.Request(HUB + "/api/v1" + path, method="GET")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=30) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers


def _admin():
    """Authenticate through the actual login API rather than reading user rows or signing a token
    locally.
    """
    st, result = _req("POST", "/admin/login", {
        "user": ADMIN_USER, "pw": ADMIN_PASS,
    })
    if st != 200 or not (result or {}).get("token"):
        raise RuntimeError("一次性 Hub 管理员登录失败：" + str(result)[:240])
    user = (result or {}).get("user") or {}
    return str(user.get("id") or ""), str(result["token"])

def _package() -> bytes:
    manifest = {
        "schemaVersion": 1, "key": KEY, "version": "1.0.0",
        "name": "（冒烟）从零写的插件", "author": "smoke",
        "description": "照 plugin-authoring.md 模板写的最小 tool-only 流程",
        "workflow": {"nodes": [
            {"key": "probe", "type": "tool", "name": "探活自己",
             "config": {"tool": "http_check",
                        "args": {"url": HUB + "/healthz", "contains": "soduwork-hub"}}},
            {"key": "tell", "type": "tool", "name": "喊人看", "dependsOn": ["probe"],
             "config": {"tool": "notify", "args": {"message": "从零插件真跑通了"}}},
        ]},
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("plugin.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return buf.getvalue()


@contextlib.contextmanager
def _isolated_hub():
    """Run the product over HTTP with disposable storage and credentials."""
    global HUB, ADMIN_USER, ADMIN_PASS
    with tempfile.TemporaryDirectory(prefix="soduwork-plugin-e2e-") as folder:
        root = pathlib.Path(folder)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        HUB = f"http://127.0.0.1:{port}"
        ADMIN_USER = "smoke-plugin-admin"
        ADMIN_PASS = secrets.token_urlsafe(24)
        env = os.environ.copy()
        isolated = {
            "DATABASE_URL": "sqlite+aiosqlite:///" + (root / ".smoke-plugin-e2e.db").as_posix(),
            "DB_MIGRATION_MODE": "auto",
            "ADMIN_USER": ADMIN_USER,
            "ADMIN_PASS": ADMIN_PASS,
            "AUTH_SECRET": secrets.token_urlsafe(36),
            "SODUWORK_DATA_ROOT": str(root / "data"),
            "REPORT_AUTO": "false",
            "POLL_INTERVAL_SECONDS": "0",
            "MINIO_ENDPOINT": "",
            "MINIO_ACCESS_KEY": "",
            "MINIO_SECRET_KEY": "",
        }
        env.update(isolated)
        previous = None
        log_path = root / "hub.log"
        with log_path.open("w+b") as log:
            proc = subprocess.Popen([
                sys.executable, "-m", "uvicorn", "app.main:app",
                "--host", "127.0.0.1", "--port", str(port),
            ], cwd=pathlib.Path(__file__).resolve().parent, env=env,
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            try:
                ready = False
                deadline = time.time() + 45
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                while time.time() < deadline and proc.poll() is None:
                    try:
                        with opener.open(HUB + "/healthz", timeout=2) as response:
                            ready = response.status == 200
                    except (OSError, urllib.error.URLError):
                        ready = False
                    if ready:
                        break
                    time.sleep(0.25)
                if not ready:
                    log.flush()
                    detail = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
                    raise RuntimeError("一次性 Hub 没有启动成功：\n" + detail)
                # The parent process imports the production package parser after the Hub
                # is ready. Point that import at the same disposable database so the live-DB
                # guard remains authoritative instead of being bypassed.
                previous = {key: os.environ.get(key) for key in isolated}
                os.environ.update(isolated)
                yield
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                # Allow for delayed SQLite-handle release after Windows process exit.
                time.sleep(1)
                if previous is not None:
                    for key, value in previous.items():
                        if value is None:
                            os.environ.pop(key, None)
                        else:
                            os.environ[key] = value

def main():
    uid, tok = _admin()
    ah = {"Authorization": "Bearer " + tok}

    st, starter_blob, starter_headers = _req_blob("/admin/plugins/starter", ah)
    from app.services import plugin_packages
    starter = plugin_packages.parse(starter_blob) if st == 200 else {}
    chk("作者起步包下载接口返回可直接预检的标准插件",
        st == 200 and starter.get("manifest", {}).get("key") == "enterprise-workflow-starter"
        and "soduwork-workflow-starter.soduwork-plugin"
        in str(starter_headers.get("Content-Disposition") or ""),
        (st, starter_headers, starter_blob[:120]))

    # Register and bind the device to the correct organization before plugin use.
    st, r = _req("POST", "/clients/register",
                 {"device": CID, "name": "（冒烟）插件实证", "platform": "smoke"})
    secret = (r or {}).get("secret") or SECRET
    dh = {"X-Soduwork-Device": CID, "X-Soduwork-Secret": secret}
    st, r = _req("POST", "/admin/clients/%s/assign" % CID, {"userId": uid}, headers=ah)
    chk("设备归属超管（任务与绑定同组织）", st == 200, (st, r))

    # Create and upload the package through multipart HTTP.
    blob = _package()
    boundary = "----smoke" + uuid.uuid4().hex
    body = (("--%s\r\nContent-Disposition: form-data; name=\"file\"; "
             "filename=\"demo.soduwork-plugin\"\r\n"
             "Content-Type: application/zip\r\n\r\n") % boundary).encode() + blob + \
        ("\r\n--%s--\r\n" % boundary).encode()
    st, r = _req("POST", "/admin/plugins/import", headers=ah, raw=body,
                 ctype="multipart/form-data; boundary=" + boundary)
    plugin = (r or {}).get("plugin") or {}
    version = plugin.get("latestVersion") or {}
    made["plugin"] = plugin.get("id") or ""
    chk("① 从零的包导入成功（进隔离区）", st == 200 and plugin.get("id")
        and version.get("id") and version.get("trustState") == "quarantined",
        (st, json.dumps(r, ensure_ascii=False)[:280]))

    # Approve plugin trust.
    st, r = _req("POST", "/admin/plugins/versions/%s/trust" % version.get("id"),
                 {"enabled": True, "confirmWithoutEvaluation": True}, headers=ah)
    chk("② 信任启用", st == 200 and (r or {}).get("trustState") == "approved", (st, r))

    # Create an organization binding and inspect readiness.
    st, r = _req("POST", "/admin/plugins/%s/bindings" % made["plugin"],
                 {"versionId": version.get("id"), "config": {}}, headers=ah)
    made["binding"] = (r or {}).get("id") or ""
    chk("③ 绑定成功且带可用性结论", st == 200 and made["binding"]
        and isinstance((r or {}).get("readiness"), dict), (st, r))

    # Create the task, start the workflow, and execute it.
    st, t = _req("POST", "/tasks", {"title": "（冒烟）从零插件真跑"}, headers=dh)
    made["task"] = (t or {}).get("id") or ""
    chk("④ 建任务", st == 200 and made["task"], (st, t))
    if not made["binding"]:
        chk("④ 流程启动", False, "绑定没成功，跳过起流程（避免误起别的插件）")
        return fail
    st, run = _req("POST", "/tasks/%s/plugin-runs" % made["task"],
                   {"bindingId": made["binding"]}, headers=dh)
    chk("④ 流程启动", st == 200 and (run or {}).get("id"), (st, run))
    run_id = (run or {}).get("id") or ""
    if (run or {}).get("bindingId") != made["binding"]:
        chk("④ 起的是本冒烟的插件（不是解析到别的绑定）", False, run)
        return fail

    deadline = time.time() + 60
    final = {}
    while time.time() < deadline:
        st, final = _req("GET", "/plugin-runs/" + run_id, headers=dh)
        if (final or {}).get("state") in ("succeeded", "failed", "cancelled"):
            break
        time.sleep(1)
    chk("④★引擎真跑 tool 节点直到 run succeeded",
        (final or {}).get("state") == "succeeded", final)
    st, t2 = _req("GET", "/tasks/" + made["task"], headers=dh)
    chk("④★run 成功任务被引擎兜底自动办结（无 publish 节点）",
        (t2 or {}).get("status") == "done", t2)

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    with _isolated_hub():
        rc = main()
    sys.exit(1 if rc else 0)
