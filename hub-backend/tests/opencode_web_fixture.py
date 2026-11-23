"""Synthetic model and approval server for native OpenCode tool-loop checks."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from app.services import local_base


class _WebFixture:
    def __init__(self):
        self.phase = "fetch"
        self.calls = []
        self.gets = []
        self.dependency_requests = 0
        self.grants = []
        self.applied = []
        self.bad_requests = []
        self.phase_calls = 0
        self.weather_in_history = False
        self.reply_in_history = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith("/npm/"):
                    # Exercise a cold, unavailable optional SDK dependency without
                    # reaching npm or borrowing the user's package cache.
                    fixture.dependency_requests += 1
                    self.reply(404, b'{"error":"Fixture registry has no packages"}')
                    return
                fixture.gets.append(self.path)
                if self.path != "/weather":
                    self.reply(404, b"Unknown fixture")
                    return
                self.reply(200, b"WEATHER-FIXTURE: Beijing Chaoyang, 21 C, clear.",
                           "text/plain; charset=utf-8")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/v1/chat/completions":
                    fixture.model(self, body)
                    return
                if self.headers.get("Authorization") != "Bearer fixture-approval":
                    fixture.bad_requests.append("approval authorization")
                    self.reply(403, b"{}")
                    return
                if self.path == "/control":
                    self.reply(200, b'{"requested":false}')
                elif self.path == "/applied":
                    fixture.applied.append(body.get("mode"))
                    self.reply(200, b'{"ok":true}')
                elif self.path == "/request":
                    arguments = body.get("arguments") or {}
                    approved = (
                        fixture.phase == "fetch" and not fixture.grants
                        and body.get("action") == "native.tool"
                        and body.get("kind") == "fetch"
                        and body.get("target") == fixture.weather_url
                        and arguments.get("url") == fixture.weather_url
                        and set(arguments) <= {"url", "format", "timeout"}
                    )
                    fixture.grants.append({"approved": approved,
                                           "kind": body.get("kind"),
                                           "argument_keys": sorted(arguments)})
                    self.reply(200, json.dumps({
                        "decision": "once" if approved else "deny",
                    }).encode())
                else:
                    fixture.bad_requests.append("unknown route")
                    self.reply(404, b"{}")

            def reply(self, code, payload, content_type="application/json"):
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.weather_url = self.url + "/weather"

    def start(self):
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def next_phase(self, phase):
        self.phase = phase
        self.phase_calls = 0

    def model(self, handler, body):
        auxiliary = not body.get("tools")
        if not auxiliary:
            self.phase_calls += 1
        names = {row.get("function", {}).get("name") for row in body.get("tools", [])}
        messages = body.get("messages") or []
        system = "\n".join(str(row.get("content") or "") for row in messages
                           if row.get("role") in {"system", "developer"})
        tool_results = [row for row in messages if row.get("role") == "tool"]
        self.calls.append({"phase": self.phase, "model": body.get("model"),
                           "stream": body.get("stream"), "webfetch": "webfetch" in names,
                           "auxiliary": auxiliary,
                           "executor_identity": "you are opencode" in system.lower()})
        if body.get("stream") is not True or self.phase_calls > 2:
            self.bad_requests.append("unexpected inference")
            handler.reply(400, b'{"error":{"message":"Unexpected fixture request"}}')
            return
        if auxiliary:
            # OpenCode may create its native session title before the tool loop.
            # Record that real inference separately from the two tool-loop calls.
            delta = {"role": "assistant", "content": "Fixture weather"}
            reason = "stop"
        elif self.phase == "resume":
            self.reply_in_history = any(
                "WEATHER-VERIFIED" in str(row.get("content") or "")
                for row in messages if row.get("role") == "assistant")
            delta = {"role": "assistant", "content": "RESUME-VERIFIED"}
            reason = "stop"
        elif self.phase_calls == 1 and (self.phase == "fetch" or "webfetch" in names):
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "weather-call-" + self.phase, "type": "function",
                "function": {"name": "webfetch", "arguments": json.dumps({
                    "url": self.weather_url, "format": "text", "timeout": 5,
                })},
            }]}
            reason = "tool_calls"
        else:
            if self.phase == "fetch":
                self.weather_in_history = any(
                    "WEATHER-FIXTURE" in str(row.get("content") or "") for row in tool_results)
            delta = {"role": "assistant", "content": (
                "WEATHER-VERIFIED" if self.phase == "fetch" else "READONLY-BLOCKED")}
            reason = "stop"
        chunks = [
            {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
             "model": "fixture", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
             "model": "fixture", "choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
             "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}},
        ]
        payload = ("".join("data: " + json.dumps(row) + "\n\n" for row in chunks)
                   + "data: [DONE]\n\n").encode()
        handler.reply(200, payload, "text/event-stream")


class OpenCodeWebChecks(unittest.TestCase):
    def environment(self, root, work, fixture, executable, mode):
        allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
                   "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}
        clean = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        for key in ("XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TEMP", "TMP"):
            target = root / key
            target.mkdir(exist_ok=True)
            clean[key] = str(target)
        clean.update({
            "SODUWORK_DATA_ROOT": str(root / "runner"),
            "OPENCODE_DB": str(root / "native.db"),
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
        })
        npmrc = root / "empty.npmrc"
        npmrc.write_text("", encoding="utf-8")
        clean.update({
            "NPM_CONFIG_USERCONFIG": str(npmrc),
            "NPM_CONFIG_GLOBALCONFIG": str(root / "empty-global.npmrc"),
            "NPM_CONFIG_CACHE": str(root / "npm-cache"),
            "NPM_CONFIG_REGISTRY": fixture.url + "/npm/",
            "NPM_CONFIG_FETCH_RETRIES": "0",
            "NPM_CONFIG_FETCH_TIMEOUT": "1000",
        })
        policy = {"mode": mode, "workspaceRoot": str(work), "policyHash": "fixture-" + mode}
        cfg = {"llm": {"base": fixture.url + "/v1", "key": "fixture-key",
                       "model": "fixture", "kind": "openai-compat"},
               "accessPolicy": policy, "workRoot": str(work)}
        with (patch.dict(os.environ, clean, clear=True),
              patch.object(local_base, "_data_root", return_value=str(root / "runner"))):
            env = local_base._env_for(local_base._PROFILES["opencode"], cfg)
        permission = policy
        env.update({
            "SODUWORK_APPROVAL_CHANNEL": json.dumps({
                "url": fixture.url, "token": "fixture-approval", "policy": policy,
            }),
            "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
            "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
        })
        return env, permission

    @staticmethod
    def session(events):
        return next((row.get("sessionID") for row in events if row.get("type") == "session"), "")

    def assert_stream(self, events, expected):
        self.assertTrue(any(row.get("type") == "text"
                            and row.get("part", {}).get("delta") == expected
                            and row.get("part", {}).get("done") is False for row in events), events)
