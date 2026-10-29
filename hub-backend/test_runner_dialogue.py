"""Runner multi-turn dialogue through real subprocesses, with synthetic vendors."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RunnerDialogueTests(unittest.TestCase):
    def test_all_profiles_await_questions_fail_empty_and_continue_after_errors(self):
        from app.services.local_base import _PROFILES
        script = Path(__file__).with_name("tests") / "runner_steering_fixture.py"
        for agent in _PROFILES:
            with self.subTest(agent=agent), tempfile.TemporaryDirectory(prefix="soduwork-dialogue-" + agent) as directory:
                process = subprocess.run([sys.executable, str(script), agent, directory, "--dialogue"],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=65,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
                self.assertEqual(process.returncode, 0, process.stdout + "\n" + process.stderr)
                result = json.loads(process.stdout.strip().splitlines()[-1])
                self.assertTrue(result["ok"])
                print(json.dumps(result), flush=True)


if __name__ == "__main__":
    unittest.main()
