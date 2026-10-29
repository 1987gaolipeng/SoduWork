"""Native Feishu registration uses the ID actually persisted by Hub normalization."""
import json
from pathlib import Path
import shutil
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.services import mcp_servers


class NativeRegistrationIdTests(unittest.TestCase):
    def run_flow(self, restore_only=False):
        scope = "0123456789abcdef" * 2
        legacy = mcp_servers.personal_spec({
            "id": "soduwork-feishu-" + scope, "name": "feishu", "type": "http",
            "url": "http://127.0.0.1:43123/mcp", "headers": {"Authorization": "Bearer fixture-local"},
            "approved": True, "approvedTarget": "http://127.0.0.1:43123/mcp", "enabled": True})
        state = {"personal": [legacy] if restore_only else [], "put": 0, "patch": 0, "probe": 0}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self, value, code=200):
                data = json.dumps(value).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def payload(self):
                return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))

            def do_GET(self):
                self.answer({"personal": state["personal"], "company": [], "enabledCompany": []})

            def do_POST(self):
                self.payload()
                state["probe"] += 1
                self.answer({"ok": True, "tools": ["fixture_read"]})

            def do_PUT(self):
                # Use the actual production validator, including 36-character IDs.
                state["personal"] = [mcp_servers.personal_spec(row) for row in self.payload()["servers"]]
                state["put"] += 1
                self.answer({"ok": True, "personal": state["personal"]})

            def do_PATCH(self):
                for change in self.payload()["changes"]:
                    row = next((row for row in state["personal"] if row["id"] == change["id"]), None)
                    if row is None:
                        return self.answer({"ok": False}, 409)
                    row["enabled"] = change["enabled"]
                state["patch"] += 1
                self.answer({"ok": True, "personal": state["personal"]})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            script = r"""
const feishu = require('./client/main/platform-connections/feishu.cjs');
const identity = { hub: process.argv[1], session: 'fixture-session' };
const scope = process.argv[2];
(async () => {
  if (process.argv[3] !== 'restore') {
    const value = {port:43123, bearer:'fixture-local'};
    await feishu.register(identity, scope, value);
    await feishu.register(identity, scope, value);
  }
  await feishu.disableRegistration(identity, scope);
})().catch(error => { console.error(error.message);process.exitCode = 1; });
"""
            result = subprocess.run([shutil.which("node"), "-e", script,
                                     "http://127.0.0.1:" + str(server.server_port), scope,
                                     "restore" if restore_only else "new"],
                                    cwd=Path(__file__).resolve().parent.parent, capture_output=True,
                                    text=True, encoding="utf-8", timeout=25)
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)
        self.assertEqual(len(state["personal"]), 1)
        self.assertEqual(state["personal"][0]["id"], legacy["id"])
        self.assertEqual(len(legacy["id"]), 36)
        self.assertFalse(state["personal"][0]["enabled"])
        self.assertEqual(state["patch"], 1)
        self.assertEqual(state["put"], 0 if restore_only else 2)
        self.assertEqual(state["probe"], 0 if restore_only else 2)

    @unittest.skipUnless(shutil.which("node"), "native registration contract needs Node.js")
    def test_initial_register_reconnect_and_disable_match_real_hub_normalization(self):
        self.run_flow()

    @unittest.skipUnless(shutil.which("node"), "native registration contract needs Node.js")
    def test_existing_normalized_id_is_disabled_without_migration_or_new_registration(self):
        self.run_flow(restore_only=True)


if __name__ == "__main__":
    unittest.main()
