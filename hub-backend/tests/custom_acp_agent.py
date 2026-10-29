"""Synthetic ACP vendor: real host file operations and a cancellable live turn."""
import json
import os
from pathlib import Path
import sys
import time


def send(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    assert os.environ["FIXTURE_MODEL"] == "fixture-model"
    assert os.environ["FIXTURE_KEY"] == "fixture-secret"
    assert Path(os.environ["FIXTURE_HOME"]).is_dir()
    cwd, resumed = "", False
    for raw in sys.stdin:
        message = json.loads(raw)
        method, params = message.get("method"), message.get("params") or {}
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {
                "loadSession": True, "sessionCapabilities": {"resume": {}}}}
        elif method == "session/new":
            cwd = params["cwd"]
            result = {"sessionId": "custom-fixture-session"}
        elif method in {"session/resume", "session/load"}:
            assert params["sessionId"] == "custom-fixture-session"
            cwd, resumed = params["cwd"], True
            assert (Path(cwd) / "custom-result.md").is_file()
            result = {}
        elif method == "session/prompt":
            text = " ".join(str(item.get("text") or "") for item in params.get("prompt") or [])
            if "WAIT_FOR_CANCELLATION" in text:
                (Path(cwd) / "custom-ready.pid").write_text(str(os.getpid()), encoding="utf-8")
                while True:
                    time.sleep(.1)
            content = "# Custom ACP\n" + ("Resumed successfully\n" if resumed else "First turn delivered\n")
            send({"jsonrpc": "2.0", "id": 900, "method": "fs/write_text_file", "params": {
                "sessionId": "custom-fixture-session", "path": str(Path(cwd) / "custom-result.md"),
                "content": content}})
            written = json.loads(sys.stdin.readline())
            assert written.get("id") == 900 and "error" not in written, written
            send({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "custom-fixture-session", "update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Delivered custom-result.md"}}}})
            result = {"stopReason": "end_turn"}
        else:
            raise AssertionError("Unexpected ACP method: " + str(method))
        send({"jsonrpc": "2.0", "id": message["id"], "result": result})


if __name__ == "__main__":
    main()
