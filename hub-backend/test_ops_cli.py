"""Execute the real operations entrypoint against inert local shell adapters."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class OperationsCliTests(unittest.TestCase):
    def test_deploy_and_rollback_export_the_canonical_root(self):
        bash = (Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
                if os.name == "nt" else shutil.which("bash"))
        self.assertTrue(bash and Path(bash).is_file(), "Bash is required for the operations contract")
        with tempfile.TemporaryDirectory(prefix="soduwork-ops-cli-") as directory:
            base = Path(directory)
            canonical, alias, commands = base / "canonical deployment", base / "alias", base / "commands"
            (canonical / "ops").mkdir(parents=True)
            commands.mkdir()
            if os.name == "nt":
                subprocess.run(["cmd", "/c", "mklink", "/J", str(alias), str(canonical)],
                               check=True, stdout=subprocess.DEVNULL, creationflags=0x08000000)
            else:
                alias.symlink_to(canonical, target_is_directory=True)
            try:
                for name in ("deploy-server.sh", "rollback-server.sh"):
                    file = canonical / "ops" / name
                    file.write_text('#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$SODUWORK_ROOT" "$SODUWORK_ROOT_DIR" "$@" > "$FIXTURE_RESULT"\n', encoding="utf-8")
                    file.chmod(0o700)
                id_stub = commands / "id"
                id_stub.write_text('#!/usr/bin/env bash\nprintf "0\\n"\n', encoding="utf-8")
                id_stub.chmod(0o700)
                archive = base / "fixture.tar.gz"
                archive.write_bytes(b"inert fixture archive; never extracted")
                result = base / "result.txt"
                env = {**os.environ, "SODUWORK_ROOT": str(alias), "FIXTURE_RESULT": str(result), "FIXTURE_COMMANDS": str(commands),
                       "PATH": str(commands) + os.pathsep + os.environ.get("PATH", "")}
                env.pop("SODUWORK_ROOT_DIR", None)
                for command, args in (("deploy", [str(archive), "fixture-release"]), ("rollback", ["--yes"])):
                    with self.subTest(command=command):
                        completed = subprocess.run([str(bash), "-c",
                                                   'export PATH="$(cd "$FIXTURE_COMMANDS" && pwd):$PATH"; exec bash "$@"',
                                                   "fixture", str(ROOT / "ops/soduworkctl"), command, *args],
                                                   env=env, capture_output=True, text=True, timeout=15)
                        self.assertEqual(completed.returncode, 0, completed.stderr)
                        values = result.read_text(encoding="utf-8").splitlines()
                        self.assertEqual(values[0], values[1])
                        native = (subprocess.check_output([str(bash), "-c", 'cygpath -m "$1"',
                                                           "fixture", values[0]], env=env, text=True).strip()
                                  if os.name == "nt" else values[0])
                        self.assertEqual(os.path.normcase(os.path.normpath(native)),
                                         os.path.normcase(str(canonical)))
                        self.assertEqual(values[2], "fixture-release" if command == "deploy" else "--yes")
                        if command == "deploy":
                            import hashlib
                            self.assertEqual(values[-1], hashlib.sha256(archive.read_bytes()).hexdigest())
            finally:
                if os.name == "nt":
                    os.rmdir(alias)
                else:
                    alias.unlink()


if __name__ == "__main__":
    unittest.main()
