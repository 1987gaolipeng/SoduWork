import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from app.services import acp_plan_history


class AcpPlanHistoryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Path(directory.name) / "local-runs"
        self.run = self.store / "old-chat"
        self.run.mkdir(parents=True)
        self.request = {"ref": self.run.name, "adapterId": "kimi", "revision": 5}
        self.command = "Check the input"
        plan = {"tool": "Plan", "state": {"input": {"command": self.command}}}
        self.parts = [plan, {**plan, "callId": "", "toolKind": ""}, plan]

    def write(self, windows=False):
        newline = b"\r\n" if windows else b"\n"
        header = "===== 第 1 段 · 09:00:00 · --soduwork-session  --soduwork-mode work =====".encode()
        events = [{"type": "session", "sessionID": "old-session"},
                  *({"type": "tool_use", "part": part} for part in self.parts)]
        # The Windows ACP process and the text-mode raw logger each add a CR.
        wire = [json.dumps(row).encode() + newline for row in events]
        self.raw = newline + header + newline + b"".join(wire).replace(b"\n", newline)
        self.meta = {"ref": self.run.name, "cli": "kimi", "cliSid": "old-session", "ws": str(self.run),
                     "state": "done", "seq": 5, "segment": 1, "eventDestination": "local",
                     "stream": {"offsets": {"err": 0, "out": sum(map(len, wire))}}}
        self.save()
        return [sum(map(len, wire[:index])) for index in range(2, 5)]

    def save(self):
        (self.run / "raw.log").write_bytes(self.raw)
        (self.run / "meta.json").write_text(json.dumps(self.meta), encoding="utf-8")

    def test_full_stream_distinguishes_a_real_same_named_tool_on_both_platforms(self):
        digest = hashlib.sha256(self.command.encode()).hexdigest()
        for windows in (False, True):
            with self.subTest(windows=windows):
                offsets = self.write(windows)
                data = acp_plan_history.lookup(self.store, self.request)
                self.assertEqual(data["plans"], [[1, offsets[0], digest], [1, offsets[1], ""], [1, offsets[2], digest]])
                self.assertEqual((data["ref"], data["revision"]), ("old-chat", 5))

    def test_separate_process_segments_restart_the_stdout_cursor(self):
        offsets = self.write()
        second = self.raw.replace("第 1 段".encode(), "第 2 段".encode())
        self.raw += second
        self.meta["segment"] = 2
        self.save()
        plans = acp_plan_history.lookup(self.store, self.request)["plans"]
        self.assertEqual([row[:2] for row in plans], [[segment, end] for segment in (1, 2) for end in offsets])

    def test_untrusted_or_incomplete_stream_cannot_certify_a_plan(self):
        for case in ("truncated", "mixed stderr", "wrong session", "another producer", "account", "running", "revision"):
            with self.subTest(case=case):
                self.write()
                if case == "truncated":
                    self.raw = self.raw[:self.raw.rfind(b"\n", 0, -1) + 1]
                elif case == "mixed stderr":
                    self.meta["stream"]["offsets"]["err"] = 20
                elif case == "wrong session":
                    self.meta["cliSid"] = "another"
                elif case == "another producer":
                    self.raw = self.raw.replace(b"--soduwork-mode", b"--native-mode")
                elif case == "account":
                    self.meta["eventDestination"] = "hub"
                elif case == "running":
                    self.meta["state"] = "running"
                else:
                    self.meta["seq"] += 1
                self.save()
                self.assertEqual(acp_plan_history.lookup(self.store, self.request), {})


if __name__ == "__main__":
    unittest.main()
