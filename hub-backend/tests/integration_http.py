"""Real Hub HTTP, migrations, integration polling and MCP on disposable loopback services.

Run with the backend test environment: python tests/integration_http.py
Only the remote MCP identity/provider is synthetic; Hub routes and persistence are real.
"""
from __future__ import annotations

import argparse
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs
import uuid

import httpx

BACKEND = Path(__file__).resolve().parents[1]


def peer_server(credential):
    seen = Counter()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, body=None):
            data = json.dumps(body).encode() if body is not None else b""
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path == "/token":
                form = parse_qs(raw.decode())
                seen["token"] += 1
                if form.get("password") != [credential] or form.get("client_secret") != [credential]:
                    return self.reply(401)
                return self.reply(200, {"access_token": credential, "expires_in": 3600})
            if self.headers.get("Authorization") != "Bearer " + credential:
                seen["denied"] += 1
                return self.reply(401)
            body = json.loads(raw)
            method = body.get("method")
            seen[method] += 1
            if method == "notifications/initialized":
                return self.reply(202)
            if method == "initialize":
                result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "isolated-integration-peer", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": [{"name": name, "description": name,
                           "inputSchema": {"type": "object", "properties": {}}}
                          for name in ("read_status", "delete_item")]}
            else:
                return self.reply(400)
            self.reply(200, {"jsonrpc": "2.0", "id": body.get("id"), "result": result})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


def main(unsupported_type="unregistered-fixture"):
    output = Path(tempfile.mkdtemp(prefix="soduwork-integration-http-"))
    credential = secrets.token_urlsafe(24)
    password = secrets.token_urlsafe(24)
    peer, seen = peer_server(credential)
    peer_url = "http://127.0.0.1:" + str(peer.server_port)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT",
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"}}
    env.update(PYTHONPATH=str(BACKEND), PYTHONUTF8="1", SODUWORK_ENV="test",
        DATABASE_URL="sqlite+aiosqlite:///" + (output / "hub.sqlite").as_posix(),
        SODUWORK_DATA_ROOT=str(output / "data"), AUTH_SECRET=secrets.token_hex(32),
        ADMIN_USER="fixture-admin", ADMIN_PASS=password, DB_MIGRATION_MODE="auto",
        HUB_LOCAL_EXECUTION_ENABLED="false", POLL_INTERVAL_SECONDS="0", DEVICE_AUTH_COMPAT="false",
        CLUSTER_REDIS_URL="", REDIS_URL="", MINIO_ENDPOINT="", JIYONG_DATABASE_URL="",
        LIBRARY_STORAGE_DIR=str(output / "library"), CLIENT_UPDATE_DIR=str(output / "updates"))
    # Check the shipped public adapters without importing a private or removed module.
    registry = subprocess.check_output([sys.executable, "-c",
        "import json; from app.connectors import REGISTRY; print(json.dumps(sorted(REGISTRY)))"],
        cwd=output, env=env, text=True, encoding="utf-8", timeout=30).strip()
    assert json.loads(registry) == ["example", "github", "gitlab", "testplat"], registry
    assert unsupported_type not in json.loads(registry)
    log = (output / "hub.log").open("w", encoding="utf-8")
    process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host",
        "127.0.0.1", "--port", str(port), "--log-level", "warning", "--no-access-log"],
        cwd=output, env=env, stdout=log, stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    checks = []
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30, trust_env=False) as client:
            deadline = time.monotonic() + 90
            while True:
                try:
                    if client.get("/healthz").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise AssertionError("Hub did not become ready; inspect " + str(output / "hub.log"))
                time.sleep(.1)

            def request(method, route, status=200, **kwargs):
                response = client.request(method, "/api/v1" + route, **kwargs)
                assert response.status_code == status, (method, route, response.status_code, response.text)
                assert credential not in response.text, "A write-only credential escaped through HTTP"
                return response.json()

            request("GET", "/admin/integrations", status=401)
            request("GET", "/admin/mcp-servers", status=401)
            auth = request("POST", "/admin/login", json={"user": "fixture-admin", "pass": password})
            client.headers["Authorization"] = "Bearer " + auth["token"]
            org = request("POST", "/admin/orgs", json={"name": "Isolated team"})
            request("POST", "/admin/users", json={"username": "fixture-member", "password": password,
                                                  "orgId": org["id"]})
            member = request("POST", "/admin/login", json={"user": "fixture-member", "pass": password})
            request("GET", "/admin/integrations", status=403,
                    headers={"Authorization": "Bearer " + member["token"]})
            request("POST", "/admin/mcp-servers/probe", status=403, json={},
                    headers={"Authorization": "Bearer " + member["token"]})
            checks.append("real migrations, login, unauthenticated and non-admin denial")

            config = {"token": credential, "mcpKey": credential,
                      "keycloak": {"clientSecret": credential, "password": credential},
                      "pullAuth": {"user": "fixture", "kind": "token", "secret": credential}}
            generic = request("POST", "/admin/integrations", json={
                "name": "Generic fixture", "type": "generic", "config": config})
            ingest_token = generic["ingestToken"]
            assert generic["config"]["pullAuth"]["secretSet"] is True
            body = {"external_id": "record-1", "title": "First isolated record"}
            request("POST", "/ingest", status=401, json=body)
            request("POST", "/ingest", json=body, headers={"X-Ingest-Token": ingest_token})
            request("POST", "/webhooks/" + generic["id"], json={**body, "title": "Updated record"},
                    headers={"X-Ingest-Token": ingest_token})
            listed = request("GET", "/admin/integrations")
            row = next(row for row in listed if row["id"] == generic["id"])
            assert row["taskCount"] == 1 and "ingestToken" not in row
            assert ingest_token not in json.dumps(listed)
            rotated = request("POST", "/admin/integrations/" + row["id"] + "/token/rotate")
            assert rotated["ingestToken"] != ingest_token
            request("POST", "/ingest", status=401, json=body, headers={"X-Ingest-Token": ingest_token})
            request("POST", "/ingest", json=body, headers={"X-Ingest-Token": rotated["ingestToken"]})
            checks.append("generic webhook ingestion, deduplication, credential masks and token rotation")

            unsupported = request("POST", "/admin/integrations", json={"name": "Custom fixture",
                "type": unsupported_type, "config": {"mcpUrl": peer_url + "/mcp"}})
            refused = request("POST", "/admin/integrations/" + unsupported["id"] + "/pull", status=400)
            assert refused["detail"] == "该类型不支持拉取"
            request("POST", "/ingest", json={"external_id": "custom-1", "title": "Custom envelope"},
                    headers={"X-Ingest-Token": unsupported["ingestToken"]})
            # Exercise the production scheduler against the same fresh, persisted database.
            code = ("import asyncio,json; from app.db import SessionLocal,engine; "
                    "from app.services.poller import run_all\n"
                    "async def main():\n async with SessionLocal() as s:\n"
                    "  print(json.dumps(await run_all(s)))\n await engine.dispose()\nasyncio.run(main())")
            polled = subprocess.check_output([sys.executable, "-c", code], cwd=output,
                                            env=env, text=True, encoding="utf-8", timeout=60)
            assert json.loads(polled)["integrations"] == 0, polled
            assert not seen, seen
            row = next(row for row in request("GET", "/admin/integrations") if row["id"] == unsupported["id"])
            assert row["lastPullAt"] is None and row["taskCount"] == 1
            checks.append("unregistered adapters reject manual pull and skip scheduling without outbound calls")

            server = {"id": str(uuid.uuid4()), "name": "fixture-business", "type": "http",
                "url": peer_url + "/mcp", "enabled": True,
                "headers": {"Authorization": "Bearer " + credential},
                "enabledTools": ["read_status"], "disabledTools": ["delete_item"]}
            request("POST", "/admin/mcp-servers/upsert", json={"server": server})
            masked = request("GET", "/admin/mcp-servers")["servers"][0]
            assert masked["headers"]["Authorization"] == "••••"
            probe = request("POST", "/admin/mcp-servers/probe", json=masked)
            assert probe["ok"] and probe["runOn"] == "hub" and probe["tools"] == ["read_status"]
            assert "delete_item" in probe["blockedTools"] and seen["tools/list"] > 0
            assert seen["denied"] == 0
            # Saving masked editor data must retain the actual stored credentials.
            request("POST", "/admin/mcp-servers/upsert", json={"server": masked, "original": masked})
            masked = request("GET", "/admin/mcp-servers")["servers"][0]
            assert request("POST", "/admin/mcp-servers/probe", json=masked)["ok"]
            checks.append("HTTP MCP save/reload, masked editor roundtrip, authenticated probe and tool policy")

            keycloak = {**masked, "headers": {}, "keycloak": {"tokenUrl": peer_url + "/token",
                "clientId": "fixture-client", "username": "fixture-user", "password": credential,
                "clientSecret": credential}}
            request("POST", "/admin/mcp-servers/upsert", json={"server": keycloak, "original": masked})
            masked = request("GET", "/admin/mcp-servers")["servers"][0]
            assert masked["keycloak"]["password"] == "••••"
            assert masked["keycloak"]["clientSecret"] == "••••"
            assert request("POST", "/admin/mcp-servers/probe", json=masked)["ok"]
            assert request("POST", "/admin/mcp-servers/probe", json=masked)["ok"]
            assert seen["token"] == 1 and seen["denied"] == 0, seen
            checks.append("shared Keycloak exchange, token reuse and write-only credential masking")

            example = request("POST", "/admin/integrations", json={"name": "Example fixture",
                "type": "example", "config": {"mcpRef": server["name"]}})
            for index in (1, 2):
                pulled = request("POST", "/admin/integrations/" + example["id"] + "/pull")
                assert pulled["ok"] and pulled["pulled"] == 1
                row = next(row for row in request("GET", "/admin/integrations") if row["id"] == example["id"])
                assert row["cursor"]["n"] == index and row["taskCount"] == index and row["lastPullOk"]
            request("PATCH", "/admin/integrations/" + example["id"], json={"enabled": False})
            request("POST", "/admin/integrations/" + example["id"] + "/pull", status=400)
            checks.append("public example adapter, shared mcpRef, incremental persistence and disabled pull")
            catalog = request("GET", "/admin/capabilities")
            entries = [item for group in ("skills", "personalSubmissions", "mcpTemplates")
                       for item in catalog[group]]
            identities = [{key: item.get(key) for key in ("key", "name", "description")}
                          for item in entries]
            assert unsupported_type.lower() not in json.dumps(identities).lower()
            checks.append("public capability catalog excludes the unsupported adapter")
        report = {"ok": True, "checks": checks, "publicAdapters": json.loads(registry),
                  "mcpRequests": dict(seen), "artifacts": str(output),
                  "boundary": "Real app.main HTTP and fresh SQLite migrations; loopback MCP identity/provider fixture"}
    finally:
        if process.poll() is None:
            if os.name == "nt":
                # The Windows venv launcher can own a child interpreter. Stop only our process tree.
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, check=True, timeout=15)
            else:
                process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        log.close()
        peer.shutdown()
        peer.server_close()
        with socket.socket() as stopped:
            stopped.settimeout(1)
            assert stopped.connect_ex(("127.0.0.1", port)) != 0, "Fixture Hub still listening"
    report["hubStopped"] = {"port": port, "launcherPid": process.pid, "verified": True}
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unsupported-type", default="unregistered-fixture")
    main(parser.parse_args().unsupported_type)
