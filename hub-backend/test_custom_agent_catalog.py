"""Private dynamic ACP registration, protocol execution and startup restoration."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


def entry():
    return {
        "id": "custom-fixture-acp", "displayName": "Custom Fixture", "summary": "Protocol fixture",
        "transport": "runner", "modelMode": "managed", "goalMode": "none", "group": "more", "order": 900,
        "accessControl": {"schema": "soduwork.access-policy/v1", "supported": False, "modes": [],
                          "approval": "", "sandbox": False},
        "runner": {"adapter": "acp", "bins": [sys.executable],
                   "args": ["-u", str(ROOT / "tests/custom_acp_agent.py")],
                   "home": {"env": "FIXTURE_HOME", "folder": ".custom-fixture-acp"},
                   "modelEnv": {"FIXTURE_BASE": "base", "FIXTURE_KEY": "key", "FIXTURE_MODEL": "model"}},
        "install": {"installer": "manual", "blurb": "Local fixture", "config_how": "Environment only"},
    }


class CustomCatalogTests(unittest.TestCase):
    def test_invalid_batches_cannot_declare_unsafe_protocol_or_capabilities(self):
        from app.services.custom_agent_catalog import validate
        cases = [
            lambda row: row.update(id="pi"),
            lambda row: row.update(transport="direct"),
            lambda row: row.update(goalMode="native"),
            lambda row: row["runner"].update(adapter="shell"),
            lambda row: row["runner"].update(bins=["powershell.exe"]),
            lambda row: row["runner"].update(bins=["../workspace/tool.exe"]),
            lambda row: row["runner"].update(args=["--eval=process.exit()"]),
            lambda row: row["runner"].update(args=["-c", "print('code')"]),
            lambda row: row["runner"].update(args="shell command"),
            lambda row: row["runner"].update(home=[]),
            lambda row: row["runner"].update(modelEnv=[]),
            lambda row: row["runner"]["home"].update(folder=".pi"),
            lambda row: row["runner"]["modelEnv"].update(NODE_OPTIONS="model"),
            lambda row: row["runner"]["modelEnv"].update(SODUWORK_KEY="key"),
            lambda row: row["runner"]["modelEnv"].update(FOO="credential"),
            lambda row: row["accessControl"].update(supported=True),
            lambda row: row["accessControl"].update(sandbox=0),
            lambda row: row["install"].update(installer="npm", pkg="example"),
            lambda row: row.update(modelMode="account"),
            lambda row: row.update(extraCode="execute this"),
        ]
        for index, mutate in enumerate(cases):
            row = entry(); mutate(row)
            with self.subTest(index=index), self.assertRaises(ValueError):
                validate([row])
        with self.assertRaises(ValueError):
            validate([entry(), entry()])
        with self.assertRaises(ValueError):
            validate([entry()] * 17)
        with self.assertRaises(ValueError):
            validate("not a list")
        self.assertEqual(validate([]), {})
        oversized = entry(); oversized["runner"]["args"] = ["x" * 2048] * 20
        with self.assertRaises(ValueError):
            validate([oversized])

    def test_discovery_keeps_a_stable_batch_during_registration(self):
        from unittest.mock import patch
        from app.services import agent_setup
        specs = {"first": {}, "second": {}}
        def discover(key, **kwargs):
            specs["added-during-probe"] = {}
            return key
        with patch.object(agent_setup, "_SPECS", specs), patch.object(agent_setup, "_load_probes", return_value={}), \
                patch.object(agent_setup, "detect", side_effect=discover):
            self.assertEqual(agent_setup.detect_all(), ["first", "second"])

    def test_registration_and_real_create_file_resume_cancel(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-custom-acp-") as directory:
            env = {**os.environ, "SODUWORK_DATA_ROOT": str(Path(directory) / "data"),
                   "PYTHONUTF8": "1", "SODUWORK_LOCAL_STALL_RETRIES": "0"}
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--fixture", directory],
                                    cwd=ROOT, env=env, capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=70,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
            self.assertEqual(result.returncode, 0, result.stdout + "\n" + result.stderr)
            report = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(report["ok"], report)
            print(json.dumps(report), flush=True)

    def test_private_startup_frame_restores_custom_agents_in_fresh_process(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-custom-restore-") as directory:
            env = {**os.environ, "SODUWORK_DATA_ROOT": str(Path(directory) / "data"), "PYTHONUTF8": "1"}
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--restore"],
                                    cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", timeout=20,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("CUSTOM_RESTORE_OK", result.stdout)


def restore_fixture():
    from io import BytesIO
    from app.services.custom_agent_catalog import restore
    from app.services.runner_lifecycle import read_config, CONFIG_PREFIX
    from app.services import agent_setup, local_base
    conf = {"customAgents": [entry()]}
    before = set(local_base._PROFILES)
    try:
        restore(conf, desktop_owned=False)
        raise AssertionError("Standalone config must not enable custom executables")
    except ValueError:
        pass
    assert set(local_base._PROFILES) == before
    frame = (CONFIG_PREFIX + json.dumps(conf) + "\n").encode("utf-8")
    stream = BytesIO(frame + b"RPC_STILL_UNREAD\n")
    restore(read_config(stream), desktop_owned=True)
    assert stream.readline() == b"RPC_STILL_UNREAD\n"
    assert entry()["id"] in local_base._PROFILES and entry()["id"] in agent_setup._SPECS
    print("CUSTOM_RESTORE_OK")


async def run_fixture(directory):
    import asyncio
    import time
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading
    from app import agent_catalog
    from app.services import (custom_agent_catalog, acp_agents, agent_setup, local_base,
                              local_stream, agent_execution_options, access_policy)
    import runner_main
    work = Path(directory)
    workspace = work / "workspace"; workspace.mkdir()
    machine = runner_main.Runner("http://127.0.0.1:1", "fixture", "fixture", "custom-fixture", str(workspace))
    before = dict(local_base._PROFILES)
    before_ids = set(agent_catalog.AGENTS)
    bad = entry(); bad["id"] = "pi"
    rejected = await machine._local_rpc_dispatch({"op": "runtime.catalog.apply", "agents": [entry(), bad]})
    assert not rejected["ok"] and rejected["code"] == "INVALID_CUSTOM_AGENT", rejected
    assert set(agent_catalog.AGENTS) == before_ids and set(local_base._PROFILES) == set(before)
    network = []
    async def receive(message):
        network.append(message)
    machine._send = receive
    await machine._on({"op": "runtime.catalog.apply", "id": "remote", "agents": [entry()], "_localParent": True})
    assert network[-1]["code"] == "LOCAL_PARENT_REQUIRED" and not network[-1]["ok"]
    assert set(agent_catalog.AGENTS) == before_ids
    first = await machine._local_rpc_dispatch({"op": "runtime.catalog.apply", "agents": [entry()]})
    assert first["ok"] and first["data"]["added"] == [entry()["id"]], first
    assert "runner" not in first["data"]["agents"][0] and "install" not in first["data"]["agents"][0]
    assert not (workspace / "custom-result.md").exists(), "registration must not start a turn"
    same = await machine._local_rpc_dispatch({"op": "runtime.catalog.apply", "agents": [entry()]})
    assert same["ok"] and not same["data"]["added"] and same["data"]["revision"] == first["data"]["revision"]
    changed = entry(); changed["displayName"] = "Another executable"
    refusal = await machine._local_rpc_dispatch({"op": "runtime.catalog.apply", "agents": [changed]})
    assert not refusal["ok"]
    assert all(local_base._PROFILES[key] is value for key, value in before.items())
    agent = entry()["id"]
    assert agent in acp_agents.CATALOG and agent in agent_setup._SPECS
    assert "local:" + agent in agent_execution_options.GATEWAY_MODEL_KINDS
    assert not access_policy.capability(agent)["supported"]
    detected = await machine._local_rpc_dispatch({"op": "runtime.detect", "key": agent})
    assert detected["ok"] and detected["data"]["installed"], detected

    class GatewayReachability(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers()
        def log_message(self, *_args):
            pass
    server = HTTPServer(("127.0.0.1", 0), GatewayReachability)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    cfg = {"local_workspace_root": str(workspace), "llm": {
        "base": f"http://127.0.0.1:{server.server_port}", "key": "fixture-secret", "model": "fixture-model"}}
    refs = set()
    async def until(check, seconds=18):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            got = await check()
            if got:
                return got
            await asyncio.sleep(.05)
        raise AssertionError({key: {name: value.get(name) for name in ("state", "error", "cliSid", "round")}
                              for key, value in local_base._RUNS.items()})
    async def status(ref):
        return (await machine._local_rpc_dispatch({"op": "job.session", "ref": ref, "limit": 1000}))["data"]
    try:
        opened = await machine._local_rpc_dispatch({"op": "job.dispatch", "cli": agent,
            "dispatchId": "custom-first", "task": {"id": "custom-test", "title": "Write a report"},
            "ctx": {"workDir": str(workspace), "conversationMode": "adaptive", "conversationUserText": "Write a report"},
            "cfg": cfg})
        assert opened["ok"], opened
        ref = opened["data"]["ref"]; refs.add(ref)
        async def done():
            data = await status(ref)
            if data.get("status") == "failed":
                raise AssertionError(data)
            return data if data.get("status") == "done" else None
        initial = await until(done)
        assert initial["cliSid"] == "custom-fixture-session", initial
        assert "First turn delivered" in (workspace / "custom-result.md").read_text(encoding="utf-8")
        assert "custom-result.md" in json.dumps(initial, ensure_ascii=False)
        for turn, text in [("second", "Revise the report"), ("third", "WAIT_FOR_CANCELLATION")]:
            accepted = await machine._local_rpc_dispatch({"op": "job.comment", "ref": ref,
                "text": text, "turnId": turn, "recordUser": True, "cfg": cfg})
            assert accepted["ok"], accepted
            if turn == "second":
                async def revised():
                    data = await status(ref)
                    return data if data.get("status") == "done" and data.get("round", 0) > initial.get("round", 0) else None
                latest = await until(revised)
                assert latest["cliSid"] == initial["cliSid"]
                assert "Resumed successfully" in (workspace / "custom-result.md").read_text(encoding="utf-8")
            else:
                async def waiting():
                    file = workspace / "custom-ready.pid"
                    return int(file.read_text(encoding="utf-8")) if file.exists() else None
                pid = await until(waiting)
                assert local_base._pid_alive(pid), "test must observe the real live ACP process before stopping"
                profile = local_base._PROFILES[agent]
                another = entry(); another["id"] = "custom-second-acp"
                another["displayName"] = "Another Custom Fixture"
                another["runner"]["home"]["folder"] = ".custom-second-acp"
                another["install"].pop("config_how")
                added_live = await machine._local_rpc_dispatch({"op": "runtime.catalog.apply", "agents": [another]})
                assert added_live["ok"], added_live
                assert acp_agents.specs()[another["id"]]["config_how"] == ""
                assert local_base._PROFILES[agent] is profile and local_base._pid_alive(pid)
                assert (await status(ref))["status"] == "running"
                stopped = await machine._local_rpc_dispatch({"op": "job.stop", "ref": ref})
                assert stopped["ok"], stopped
                async def ended():
                    data = await status(ref)
                    return data if data.get("status") == "stopped" else None
                await until(ended)
                assert not local_base._pid_alive(pid), "ACP subprocess must exit after cancellation"
        print(json.dumps({"ok": True, "registration": "private-additive-idempotent", "newAgentId": agent,
                          "nativeSessionResumed": True, "realFileDelivery": True, "realProcessCancelled": True,
                          "builtInProfilesUnchanged": True, "activeProcessPreservedOnAdd": True,
                          "networkRegistrationRejected": True}))
    finally:
        for ref in refs:
            if local_stream.is_running(ref):
                await asyncio.to_thread(local_stream.stop_sync, {}, ref)
        if machine._admission_task:
            machine._admission_task.cancel()
            await asyncio.gather(machine._admission_task, return_exceptions=True)
        await asyncio.gather(*machine._admission_workers, return_exceptions=True)
        for thread in list(local_base._THREADS):
            await asyncio.to_thread(thread.join, 3)
        machine._admission._journal.close()
        server.shutdown(); server.server_close()


if __name__ == "__main__":
    if "--fixture" in sys.argv:
        import asyncio
        asyncio.run(run_fixture(sys.argv[2]))
    elif "--restore" in sys.argv:
        restore_fixture()
    else:
        unittest.main()
