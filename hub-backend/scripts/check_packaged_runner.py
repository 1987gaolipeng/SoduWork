"""Exercise the delivered Runner binary without real accounts, Hub or models."""
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

PREFIX = "@@SODUWORK_LOCAL_RPC@@"
CONFIG = "@@SODUWORK_RUNNER_CONFIG@@"

def main():
    exe = Path(sys.argv[1]).resolve()
    root = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(tempfile.mkdtemp(prefix="soduwork-runner-acceptance-"))
    root.mkdir(parents=True, exist_ok=True)
    checks = []
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    clients = []
    def accept():
        while True:
            try:
                conn, _ = listener.accept()
                clients.append(conn)  # Deliberately never complete the WebSocket handshake.
            except OSError:
                return
    threading.Thread(target=accept, daemon=True).start()
    config = dict(hub="http://127.0.0.1:" + str(listener.getsockname()[1]),
                  clientId="installer-fixture", runnerId="installer-" + uuid.uuid4().hex,
                  dataRoot=str(root / "data"), workRoot=str(root / "work"),
                  capabilityGrants=[], tags=["soduwork-client"])
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", SODUWORK_DATA_ROOT=config["dataRoot"])
    for key in ["SODUWORK_HUB", "SODUWORK_RUNNER_TOKEN", "SODUWORK_RUNNER_KEY", "SODUWORK_DEVICE_SECRET", "SODUWORK_RUNNER_ID", "SODUWORK_WORK_ROOT", "SODUWORK_RUNNER_TAGS"]:
        env.pop(key, None)
    running = []
    def start(name, early_close=False):
        err = open(root / (name + ".stderr.log"), "wb")
        proc = subprocess.Popen([str(exe), "--config-stdin"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=err, cwd=root, env=env)
        err.close()
        running.append(proc)
        replies = queue.Queue()
        def read():
            for line in proc.stdout:
                if line.startswith(PREFIX.encode()):
                    replies.put(json.loads(line[len(PREFIX):]))
        threading.Thread(target=read, daemon=True).start()
        proc.stdin.write((CONFIG + json.dumps(config, ensure_ascii=False) + "\n").encode("utf-8"))
        proc.stdin.flush()
        if early_close:
            proc.stdin.close()
            return proc, replies
        proc.stdin.write((PREFIX + json.dumps(dict(id="ping", message=dict(op="runtime.ping"))) + "\n").encode())
        proc.stdin.flush()
        reply = replies.get(timeout=25)
        assert reply["ok"] and reply["result"]["data"]["pid"] > 0, reply
        return proc, replies
    def finish(proc, name):
        started = time.monotonic()
        code = proc.wait(timeout=10)
        assert code == 0, (name, code)
        elapsed = time.monotonic() - started
        checks.append(dict(name=name, exitCode=code, shutdownSeconds=round(elapsed, 3)))
        print("PASS", name, flush=True)
    try:
        proc, _ = start("pipe-config")
        proc.stdin.close()
        finish(proc, "stdin EOF stops desktop Runner while Hub handshake is pending")
        proc, _ = start("same-id-restart")
        proc.stdin.write((PREFIX + json.dumps(dict(id="stop", message=dict(op="runtime.shutdown"))) + "\n").encode())
        proc.stdin.flush()
        finish(proc, "same-id restart releases lock; explicit shutdown works with stdin open")
        proc.stdin.close()
        proc, _ = start("immediate-close", early_close=True)
        finish(proc, "desktop closes during onefile bootstrap")
        # Invalid/truncated startup frames must fail, never fall back to a different device.
        bad = subprocess.run([str(exe), "--config-stdin"], input=b"{}\n", capture_output=True, env=env, cwd=root, timeout=20)
        assert bad.returncode == 2, bad.stderr.decode("utf-8", "replace")
        checks.append(dict(name="invalid startup configuration rejected", exitCode=bad.returncode))
        (root / "report.json").write_text(json.dumps(dict(ok=True, runner=str(exe), checks=checks), indent=2), encoding="utf-8")
    finally:
        for proc in running:
            if proc.poll() is None:
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
            try:
                proc.stdin.close()
            except (OSError, ValueError):
                pass
        listener.close()
        for conn in clients:
            conn.close()

if __name__ == "__main__":
    main()
