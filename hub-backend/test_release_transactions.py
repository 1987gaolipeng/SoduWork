"""Real Bash release transactions with inert command adapters and fault injection.
No Docker daemon, services, network or business data. Linux --network none compatible.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = r'''#!/usr/bin/env bash
set -eu
name="${0##*/}"
printf '%s' "$name" >> "$FIXTURE/events"
printf ' <%s>' "$@" >> "$FIXTURE/events"
printf '\n' >> "$FIXTURE/events"
value() { sed -n "s/^$1=//p" "$2" | tail -1; }
once() { [[ "$FAULT" == "$1" && ! -e "$FIXTURE/fault-fired" ]] || return 1; touch "$FIXTURE/fault-fired"; }
image() {
 case "$1" in
  *:latest) cat "$FIXTURE/latest";;
  *:fixture-next) printf 'sha256:%064d' 3;;
  *:fixture-current) printf 'sha256:%064d' 2;;
  *:fixture-previous) printf 'sha256:%064d' 1;;
  sha256:*) printf '%s' "$1";; *) exit 92;;
 esac
}
revision() {
 case "$(image "$1")" in
  *1) printf fixture-previous;; *2) printf fixture-current;; *3) printf fixture-next;; *) exit 93;;
 esac
}
case "$name" in
 id) printf '0\n'; exit;;
 flock|sleep) exit;;
 curl)
  [[ "$(cat "$FIXTURE/running")" == yes ]] || exit 7
  printf '{"version":"%s","commit":"%s","deployedAt":"%s"}\n' \
   "$(revision "$(cat "$FIXTURE/running-image")")" "$(revision "$(cat "$FIXTURE/running-image")")" \
   "$(value SODUWORK_DEPLOY_AT "$ROOT_PATH/.env")"
  exit;;
 docker) ;; *) exit 94;;
esac
case "$1" in
 compose)
  shift
  while [[ "$1" == --env-file || "$1" == -f ]]; do shift 2; done
  action="$1"; shift
  case "$action" in
   version) exit;;
   ps) printf '%s\n' "${@: -1}-container"; exit;;
   stop) printf no > "$FIXTURE/running"; if once stop; then exit 42; fi; exit;;
   up) cat "$FIXTURE/latest" > "$FIXTURE/running-image"; printf yes > "$FIXTURE/running"; exit;;
   exec)
    shift 2
    command="$1"; shift
    case "$command" in
     pg_dump)
      if [[ "$(cat "$FIXTURE/running")" == no ]]; then
       if once dump; then printf 'partial dump'; exit 73; fi
       if once INT; then kill -INT "$PPID"; fi
       if once TERM; then kill -TERM "$PPID"; fi
      fi
      cat "$FIXTURE/database"; exit;;
     pg_restore)
      if [[ " $* " == *' --list '* ]]; then cat >/dev/null; printf 'fixture restore list\n'; exit; fi
      target=''
      while [[ $# -gt 0 ]]; do if [[ "$1" == -d ]]; then target="$2"; break; fi; shift; done
      if [[ "$target" == fixture_business ]]; then
       cat > "$FIXTURE/database"
       if once restore; then printf corrupted > "$FIXTURE/database"; exit 74; fi
      else cat >/dev/null; if once probe_restore; then exit 76; fi; fi
      exit;;
     psql) exit;; *) exit 95;;
    esac;;
   *) exit 96;;
  esac;;
 inspect)
  format="$3"
  case "$format" in
   *Config.Image*) printf 'fixture-hub:latest\n';;
   *Config.Labels*) revision "$(cat "$FIXTURE/running-image")";;
   *NetworkSettings*) printf 'fixture-network\n';;
   *'.Image'*) cat "$FIXTURE/running-image";; *) exit 97;;
  esac; exit;;
 image)
  if [[ "$*" != *--format* ]]; then exit; fi
  if [[ "$4" == *Config.Labels* ]]; then revision "${@: -1}"; else image "${@: -1}"; fi
  exit;;
 exec)
  case "${@: -1}" in
   *POSTGRES_USER*) printf fixture_user;;
   *POSTGRES_DB*) printf fixture_business;;
   *DATABASE_URL*) printf 'postgresql+asyncpg://fixture@fixture/fixture_business';; *) exit 98;;
  esac; exit;;
 tag) if [[ "$3" == *:latest ]]; then image "$2" > "$FIXTURE/latest"; fi; exit;;
 build) exit;;
 run)
  if [[ "$*" == *'python - /release.tar.gz'* ]]; then cat >/dev/null; exit; fi
  if [[ "$*" == *'--help'* ]]; then exit; fi
  environment=''
  while [[ $# -gt 0 ]]; do if [[ "$1" == --env-file ]]; then environment="$2"; shift; fi; shift; done
  target="$(value DATABASE_URL "$environment")"
  mode="$(value DB_MIGRATION_MODE "$environment")"
  if [[ "$target" == */fixture_business && "$mode" == auto ]]; then
   if once migrate; then printf partially-migrated > "$FIXTURE/database"; exit 75; fi
   if once armed-TERM; then printf partially-migrated > "$FIXTURE/database"; kill -TERM "$PPID"; fi
  fi
  exit;;
 *) exit 99;;
esac
'''


class ReleaseTransactionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-release-transaction-")
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.deployment = self.base / "deployment"
        self.commands = self.base / "commands"
        self.commands.mkdir()
        self.state = self.deployment / "data/deployments"
        self.backups = self.deployment / "data/backups"
        for path in (self.state / "history", self.backups, self.deployment / "ops"):
            path.mkdir(parents=True, exist_ok=True)
        self.current = "sha256:" + str(2).zfill(64)
        self.previous = "sha256:" + str(1).zfill(64)
        for name, contents in (("latest", self.current), ("running-image", self.current),
                               ("running", "yes"), ("database", "current-business-rows"), ("events", "")):
            (self.base / name).write_text(contents)
        self.environment = self.deployment / ".env"
        self.environment.write_text("DB_MIGRATION_MODE=check\nSODUWORK_DEPLOY_COMMIT=fixture-current\nSODUWORK_DEPLOY_AT=current-time\n")
        (self.deployment / "compose.yml").write_text("# Inert fixture, never passed to Docker\n")
        oldenv = self.backups / "previous.env"
        oldenv.write_text("DB_MIGRATION_MODE=check\nSODUWORK_DEPLOY_COMMIT=fixture-previous\nSODUWORK_DEPLOY_AT=previous-time\n")
        olddump = self.backups / "previous.dump"
        olddump.write_text("previous-business-rows")
        record = self.state / "history/current.env"
        self.bash = (str(ROOT / "client/.runtime/git/bin/bash.exe")
                     if os.name == "nt" else shutil.which("bash"))
        if os.name == "nt" and not Path(self.bash).is_file():
            self.bash = str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe")
        self.assertTrue(self.bash and Path(self.bash).is_file(), "Bash is required")
        self.posix = lambda p: str(p).replace("\\", "/")
        if os.name == "nt":
            def to_posix(p):
                return subprocess.check_output([self.bash, "-c", 'cygpath -u "$1"', "fixture", str(p)], text=True).strip()
            self.posix = to_posix
        record.write_text("\n".join(("from_release=fixture-previous", "to_release=fixture-current",
            "from_image_id=" + self.previous, "database_backup=" + self.posix(olddump),
            "database_backup_sha256=" + hashlib.sha256(olddump.read_bytes()).hexdigest(),
            "environment_backup=" + self.posix(oldenv),
            "environment_backup_sha256=" + hashlib.sha256(oldenv.read_bytes()).hexdigest(),
            "previous_deployment_record=", "previous_deployed_at=previous-time", "")))
        (self.state / "current.env").write_text("release=fixture-current\ndeployment_record=" + self.posix(record) + "\n")
        for command in ("docker", "curl", "id", "flock", "sleep"):
            file = self.commands / command
            file.write_text(ADAPTER, newline="\n")
            file.chmod(0o700)
        payload = self.base / "source"
        (payload / "hub-backend").mkdir(parents=True)
        (payload / "ops").mkdir()
        (payload / "Dockerfile.server").write_text("# fixture\n")
        (payload / "hub-backend/db_admin.py").write_text("# fixture\n")
        install = payload / "ops/install-operations.sh"
        install.write_text('#!/usr/bin/env bash\nexit 0\n', newline="\n")
        install.chmod(0o755)
        self.archive = self.base / "source.tar.gz"
        with tarfile.open(self.archive, "w:gz") as tar:
            for path in sorted(payload.rglob("*")):
                tar.add(path, arcname=path.relative_to(payload).as_posix(), recursive=False)
        self.archive_sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def run_script(self, operation, fault="", repository=None):
        env = {**os.environ, "FIXTURE": self.posix(self.base), "ROOT_PATH": self.posix(self.deployment),
               "SODUWORK_ROOT_DIR": self.posix(self.deployment), "FIXTURE_COMMANDS": self.posix(self.commands),
               "SODUWORK_OPERATION_LOCK_FILE": self.posix(self.base / "operation.lock"), "FAULT": fault,
               "MSYS2_ARG_CONV_EXCL": "*"}
        for key in ("SODUWORK_IMAGE_REPO", "SODUWORK_COMPOSE_FILE", "SODUWORK_ENV_FILE", "SODUWORK_BUILD_ROOT",
                    "SODUWORK_BACKUP_DIR", "SODUWORK_DEPLOYMENT_STATE_DIR", "SODUWORK_OPS_ENTRYPOINT"):
            env.pop(key, None)
        if repository is not None:
            with self.environment.open("a") as stream:
                stream.write("SODUWORK_IMAGE_REPO=" + repository + "\n")
        args = (["fixture-next", self.posix(self.archive), self.archive_sha] if operation == "deploy" else ["--yes"])
        result = subprocess.run([self.bash, "-c", 'export PATH="$FIXTURE_COMMANDS:$PATH"; exec bash "$@"',
                                 "fixture", self.posix(ROOT / f"ops/{operation}-server.sh"), *args],
                                env=env, capture_output=True, text=True, encoding="utf-8", timeout=25)
        self.events = (self.base / "events").read_text().splitlines()
        self.output = result.stdout + result.stderr
        return result

    def assert_original_restored(self):
        self.assertEqual((self.base / "running").read_text(), "yes", self.output)
        self.assertEqual((self.base / "running-image").read_text(), self.current, self.output)
        self.assertEqual((self.base / "database").read_text(), "current-business-rows", self.output)
        self.assertIn("SODUWORK_DEPLOY_COMMIT=fixture-current", self.environment.read_text())
        self.assertFalse(any("<tag>" in row and "<soduwork-hub:latest>" in row for row in self.events))

    def test_manual_rollback_infers_repository_and_stops_before_dump(self):
        result = self.run_script("rollback")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.base / "running-image").read_text(), self.previous)
        self.assertEqual((self.base / "database").read_text(), "previous-business-rows")
        stop = next(i for i, row in enumerate(self.events) if "<stop>" in row)
        dump = next(i for i, row in enumerate(self.events) if "<pg_dump>" in row)
        restore = next(i for i, row in enumerate(self.events) if "<pg_restore>" in row and "<-d> <fixture_business>" in row)
        self.assertLess(stop, dump)
        self.assertLess(dump, restore)
        self.assertTrue(any("<tag>" in row and "<fixture-hub:latest>" in row for row in self.events))

    def test_configured_repository_matches_current_image(self):
        result = self.run_script("rollback", repository="fixture-hub")
        self.assertEqual(result.returncode, 0, self.output)

    def test_wrong_repository_rejected_before_stopping_or_database_writes(self):
        result = self.run_script("rollback", repository="wrong-hub")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("configured image repository differs", self.output)
        self.assertFalse(any("<stop>" in row or "<pg_dump>" in row for row in self.events))
        self.assert_original_restored()

    def test_deploy_rejects_inconsistent_repository_before_database_operations(self):
        result = self.run_script("deploy", repository="wrong-hub")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("configured image repository differs", self.output)
        self.assertFalse(any("<stop>" in row or "<pg_dump>" in row for row in self.events))
        self.assert_original_restored()

    def test_unsafe_repository_is_never_used_as_an_image_argument(self):
        result = self.run_script("rollback", repository="fixture-hub;false")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe image repository", self.output)
        self.assertFalse(any("<stop>" in row or "<tag>" in row for row in self.events))
        self.assert_original_restored()

    def test_failed_probe_restore_removes_the_created_database(self):
        result = self.run_script("rollback", "probe_restore")
        self.assertEqual(result.returncode, 76, self.output)
        drops = [row for row in self.events if "DROP DATABASE" in row and "soduwork_rollback_probe_" in row]
        self.assertEqual(len(drops), 2, self.output)
        self.assertFalse(any("<stop>" in row for row in self.events))
        self.assert_original_restored()

    def test_deployment_completes_with_current_repository(self):
        result = self.run_script("deploy")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.base / "running-image").read_text(), "sha256:" + str(3).zfill(64))
        self.assertEqual((self.base / "database").read_text(), "current-business-rows")


def recovery_case(operation, fault, expected):
    def test(self):
        self.assertEqual(self.run_script(operation, fault).returncode, expected, self.output)
        self.assert_original_restored()
        if fault in ("stop", "dump", "INT", "TERM"):
            self.assertFalse(any("<pg_restore>" in row and "<-d> <fixture_business>" in row for row in self.events), self.output)
    return test


for operation, fault, expected in (
    ("deploy", "stop", 42), ("rollback", "stop", 42),
    ("deploy", "dump", 73), ("rollback", "dump", 73),
    ("deploy", "migrate", 75), ("rollback", "restore", 74),
    ("deploy", "armed-TERM", 143), ("deploy", "INT", 130), ("rollback", "TERM", 143),
    ("deploy", "TERM", 143), ("rollback", "INT", 130),
):
    setattr(ReleaseTransactionTests, "test_" + operation + "_recovers_" + fault.replace("-", "_"),
            recovery_case(operation, fault, expected))

if __name__ == "__main__":
    unittest.main(verbosity=2)
