"""Real protocol peer and production Runner handler for isolated regression tests."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

def protocol_server():
    seen = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if self.headers.get("Authorization") not in ("Bearer private-fixture-key", "Bearer company-fixture-key"):
                self.send_response(401); self.end_headers(); return
            method = body.get("method")
            seen.append(method)
            if method == "notifications/initialized":
                self.send_response(202); self.end_headers(); return
            if method == "initialize":
                result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "isolated-business", "version": "1.0"}}
            elif method == "tools/list":
                result = {"tools": [
                    {"name": "read_status", "description": "Read status", "inputSchema": {"type": "object", "properties": {}}},
                    {"name": "delete_item", "description": "Delete item", "inputSchema": {"type": "object", "properties": {}}}]}
            elif method == "tools/call":
                result = {"content": [{"type": "text", "text": "BUSINESS_OK:" + str(body["params"]["name"])}]}
            else:
                result = {}
            data = json.dumps({"jsonrpc": "2.0", "id": body.get("id"), "result": result}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    return server, "http://127.0.0.1:" + str(server.server_port) + "/mcp", seen


class LocalRunner:
    """Only registry transport is in-process. Handler/network/bridge/policy are real."""
    version = "1.12.30"
    def __init__(self, client_id):
        self.id = "fixture-" + client_id
        self.host = "Isolated " + client_id
        self.skill_catalog = []
        self.skills = []
        self.skills_known = True
    def alive(self):
        return True
    async def call(self, op, data, timeout=0):
        from runner_main import Runner
        return await Runner._mcp(self, {"op": op, **data})


def runners():
    from app.services import runner_hub
    peers = {key: LocalRunner(key) for key in ("device-alice", "device-bob")}
    return patch.object(runner_hub, "for_client", lambda key: peers.get(key))


def config(url):
    return {"mcpServers": {"business": {"type": "http", "url": url,
        "headers": {"Authorization": "Bearer private-fixture-key"},
        "enabled_tools": ["read_status"], "disabled_tools": ["delete_item"],
        "startup_timeout_sec": 10, "tool_timeout_sec": 30}}}
