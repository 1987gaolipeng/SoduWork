"""Real Hub/Runner WebSocket acceptance without a live client or real model.

Only disposable profiles, loopback ports and synthetic vendor CLI are used.
Evidence stays under --output; every child belongs to this fixture process.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
from contextlib import closing
import subprocess
import sys
import tempfile
import time

import httpx

BACKEND = Path(__file__).resolve().parent
FIXTURE = BACKEND / "tests/cloud_durable_fixture.py"
DEPENDENCY_OVERLAY_ENV = "SODUWORK_E2E_DEPENDENCY_OVERLAY"
EXPECTED_VERSIONS_ENV = "SODUWORK_E2E_EXPECTED_VERSIONS"


def _dependencies(overlay=None, expected=None):
    overlay = overlay if overlay is not None else os.environ.get(DEPENDENCY_OVERLAY_ENV, "")
    expected = expected if expected is not None else os.environ.get(EXPECTED_VERSIONS_ENV, "")
    if not overlay and not expected:
        return None, {}
    if not overlay or not expected:
        raise ValueError("Fixture dependency overlay and expected versions must be provided together")
    path = Path(overlay).expanduser().resolve(strict=True)
    if not path.is_dir():
        raise ValueError("Fixture dependency overlay must be an existing directory")
    versions = json.loads(expected) if isinstance(expected, str) else expected
    if (not isinstance(versions, dict) or set(versions) != {"fastapi", "starlette", "pydantic"}
            or any(not isinstance(value, str) or not value.strip() for value in versions.values())):
        raise ValueError("Fixture expected versions must name FastAPI, Starlette and Pydantic exactly")
    return path, dict(versions)


def _child_environment(root, role, overlay=None):
    profile = root / (role + "-profile")
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("SODUWORK_", "SODUWORK_", "OPENAI_", "ANTHROPIC_"))}
    for key in ("NODE_OPTIONS", "PYTHONPATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", HOME=str(profile), USERPROFILE=str(profile),
        APPDATA=str(profile / "AppData/Roaming"), LOCALAPPDATA=str(profile / "AppData/Local"),
        XDG_CONFIG_HOME=str(profile / "config"), CODEX_HOME=str(profile / "codex"),
        CLAUDE_CONFIG_DIR=str(profile / "claude"), PI_CODING_AGENT_DIR=str(profile / "pi"),
        NO_PROXY="*", SODUWORK_DATA_ROOT=str(root / (role + "-data")),
        DATABASE_URL="sqlite+aiosqlite:///:memory:", AUTH_SECRET="isolated-fixture-only",
        CLUSTER_REDIS_URL="", REDIS_URL="", MINIO_ENDPOINT="", SODUWORK_LOCAL_STALL_RETRIES="0")
    if overlay is not None:
        env["PYTHONPATH"] = str(overlay)
    return env


def _check_dependencies(role, actual, expected):
    if expected and actual != expected:
        raise AssertionError("Fixture %s dependency mismatch: expected %r, actual %r" %
                             (role, expected, actual))


def wait_for(check, *, timeout=90, label="fixture condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError("Timed out waiting for " + label)


def run(output, *, dependency_overlay=None, expected_versions=None):
    overlay, expected = _dependencies(dependency_overlay, expected_versions)
    root = Path(tempfile.mkdtemp(prefix="cloud-durable-", dir=output))
    print("Fixture evidence: " + str(root), flush=True)
    children, logs = {}, []
    def launch(role):
        profile = root / (role + "-profile")
        profile.mkdir()
        env = _child_environment(root, role, overlay)
        log = (root / (role + ".log")).open("wb")
        logs.append(log)
        process = subprocess.Popen([sys.executable, str(FIXTURE), role, str(root)],
            cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        children[role] = process
        return process

    def alive(role):
        assert children[role].poll() is None, (role + " exited; inspect " + str(root / (role + ".log")))

    def ready_file():
        alive("hub")
        return (root / "ready.json").exists()

    try:
        launch("hub")
        wait_for(ready_file, timeout=180, label="isolated Hub startup")
        ready = json.loads((root / "ready.json").read_text(encoding="utf-8"))
        _check_dependencies("hub", ready.get("dependencies"), expected)
        print("Fixture Hub dependencies: " + json.dumps(ready["dependencies"]), flush=True)
        launch("runner")
        with httpx.Client(base_url=ready["hub"], timeout=15, trust_env=False) as control:
            def state():
                alive("hub")
                alive("runner")
                response = control.get("/__fixture/state")
                response.raise_for_status()
                return response.json()
            wait_for(lambda: state()["runnerOnline"] and {"files", "terminal"}.issubset(
                state()["available"]), label="real Runner WebSocket and capability report")
            assert "sessionAck1" in state()["caps"]
            runner_dependencies = json.loads((root / "runner-dependencies.json").read_text(encoding="utf-8"))
            _check_dependencies("runner", runner_dependencies, expected)
            print("Fixture Runner dependencies: " + json.dumps(runner_dependencies), flush=True)
            observer = launch("observer")
            assert observer.wait(timeout=120) == 0, "Observer failed; inspect observer.log"
            assert observer.poll() is not None, "Observer must actually exit before work completes"
            wait_for(lambda: (root / "launched.json").exists(), label="synthetic vendor child")
            workspace = Path(json.loads((root / "launched.json").read_text(encoding="utf-8"))["workspace"]).resolve()
            assert workspace.is_relative_to(root.resolve())
            assert not (workspace / "delivery.md").exists()
            assert control.post("/__fixture/disconnect").is_success
            (workspace / "hold-process").unlink()
            wait_for(lambda: (workspace / "delivery.md").exists(), timeout=5, label="offline vendor completion")
            def pending_packets():
                paths = list((root / "runner-data/runner-events").glob("*/events.sqlite3"))
                if not paths:
                    return False
                with closing(sqlite3.connect(str(paths[0]))) as connection:
                    return connection.execute("SELECT COUNT(*) FROM packets").fetchone()[0] > 0
            wait_for(pending_packets, timeout=5, label="offline durable outbox")
            def settled():
                current = state()
                if (current["state"] == "done" and current["eventCount"] > 0
                        and current["metadata"].get("terminalSettlement", {}).get("state") == "done"):
                    return current
                return None
            completed = wait_for(settled, timeout=150, label="autonomous event and artifact settlement")
            assert "deliverySync" not in completed["metadata"], completed
            assert completed["statusReads"] == 0, completed
            assert completed["deliverySeq"] > 0
            assert completed["persistedThrough"] == completed["seq"]
            assert "delivery.md" in completed["attachments"]
            assert len(completed["attachments"]) == len(set(completed["attachments"])), (
                "Concurrent terminal settlement duplicated output ingestion", completed["attachments"])
            wait_for(lambda: not pending_packets(), label="durable ACK clears Runner outbox")
            (root / "completed-without-client.json").write_text(json.dumps(completed), encoding="utf-8")
            # The cold reader sees only database state; the Runner can be offline.
            (root / "runner-stop").touch()
            assert children["runner"].wait(timeout=20) == 0
            cold_reader = launch("reader")
            assert cold_reader.wait(timeout=60) == 0, "Cold reader failed; inspect reader.log"
            prompts = (workspace / ".cache/prompts.jsonl").read_text(encoding="utf-8").splitlines()
            assert len(prompts) == 1, "Transport reconnect must never launch the model twice"
        print("PASS independent observer exited; real Runner finished through WebSocket loss", flush=True)
        print("PASS events, durable ACK and verified delivery persisted without ai-status GET", flush=True)
        print("PASS cold reader restored process and results while Runner was stopped", flush=True)
    finally:
        (root / "runner-stop").touch()
        (root / "hub-stop").touch()
        for role, process in reversed(list(children.items())):
            if process.poll() is None:
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                            capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                    else:
                        process.terminate()
                    process.wait(timeout=15)
        for log in logs:
            log.close()
    return root


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dependency-overlay", type=Path)
    parser.add_argument("--expected-versions", help="JSON containing exact fastapi, starlette and pydantic versions")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    run(args.output.resolve(), dependency_overlay=args.dependency_overlay,
        expected_versions=args.expected_versions)
