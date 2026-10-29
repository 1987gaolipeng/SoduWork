"""Deterministic ACP peer for Harness² process integration; never a real model."""
import json
import os
from pathlib import Path
import sys


def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding="utf-8")
assert "SODUWORK_HARNESS2_MODEL" not in os.environ
assert "SODUWORK_APPROVAL_CHANNEL" not in os.environ
workspace = Path.cwd()
for raw in sys.stdin:
    message = json.loads(raw)
    method = message.get("method")
    params = message.get("params") or {}
    result = {}
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
    elif method in {"session/new", "session/load"}:
        if method == "session/load":
            assert params["sessionId"] == "harness2-native-fixture"
        result = {"sessionId": "harness2-native-fixture"}
    elif method == "session/prompt":
        prompt = "\n".join(row.get("text", "") for row in params["prompt"])
        (workspace / "received.txt").write_text(prompt, encoding="utf-8")
        send({"jsonrpc": "2.0", "id": 800, "method": "fs/write_text_file",
              "params": {"path": str(workspace / "delivered.txt"), "content": "actual bridge write"}})
        response = json.loads(sys.stdin.readline())
        if os.environ.get("HARNESS2_FIXTURE_READONLY") == "1":
            assert "error" in response
            answer = "Write blocked by readonly permission"
        else:
            assert "error" not in response, response
            answer = "Fixture completed"
        send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": "harness2-native-fixture", "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": answer}}}})
        result = {"stopReason": "end_turn"}
    else:
        raise AssertionError("Unexpected method: " + str(method))
    send({"jsonrpc": "2.0", "id": message["id"], "result": result})
