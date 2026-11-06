"""Safety contracts and isolated real-shell deployment/rollback routing."""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
deploy = (ROOT / "ops" / "deploy-server.sh").read_text(encoding="utf-8")
rollback = (ROOT / "ops" / "rollback-server.sh").read_text(encoding="utf-8")
installer = (ROOT / "ops" / "install-operations.sh").read_text(encoding="utf-8")
database_backup = (ROOT / "ops" / "backup" / "database-backup.sh").read_text(encoding="utf-8")
health = (ROOT / "ops" / "backup" / "backup-health.sh").read_text(encoding="utf-8")
checks = 0


def ok(condition: bool, message: str) -> None:
    global checks
    checks += 1
    assert condition, message


ok(set(re.findall(r"/opt/[A-Za-z0-9_-]+", deploy + rollback + installer)) == {"/opt/soduwork"}
   and all('${SODUWORK_ROOT_DIR:-/opt/soduwork}' in script for script in (deploy, rollback))
   and '${SODUWORK_ROOT:-/opt/soduwork}' in installer,
   "release operations must default to SoduWork and preserve explicit root overrides")
ok("/run/lock/soduwork-operations.lock" in deploy
   and "/run/lock/soduwork-operations.lock" in rollback,
   "deployment and rollback do not share an exclusive operation lock")
ok("PROBE_DATABASE" in deploy and "run_migration" in deploy,
   "deployment does not rehearse migrations against a restored database")
ok("ROLLBACK_ARMED" in deploy and "restore_database" in deploy
   and "restore_environment" in deploy,
   "deployment does not automatically restore database and environment")
ok("database_backup_sha256=" in deploy and "environment_backup_sha256=" in deploy,
   "deployment record lacks rollback artifact checksums")
ok("previous_deployment_record=" in deploy and "deployment_record=" in deploy,
   "deployment history is not linked for repeated one-step rollbacks")
ok("rollback-emergency-" in rollback and "ROLLBACK_ARMED" in rollback,
   "active rollback has no pre-rollback recovery point")
ok("run_migration_check" in rollback and "PROBE_DATABASE" in rollback,
   "rollback target is not rehearsed against an isolated restore")
ok("--yes" in rollback and "interactive confirmation" in rollback,
   "destructive rollback has no explicit confirmation contract")
ok("pg_dump" in database_backup and "pg_restore --list" in database_backup
   and "sha256sum" in database_backup,
   "scheduled PostgreSQL backup lacks structural or checksum verification")
ok("MAX_DB_AGE_SECONDS" in health and "MAX_FULL_AGE_SECONDS" in health
   and "MAX_DRILL_AGE_SECONDS" in health,
   "backup health does not enforce recovery point objectives")
ok("docker run --rm -i" in health,
   "containerized backup receipt validation cannot receive its verification program")
ok("python3" not in deploy + rollback + installer + database_backup + health,
   "server operations must not depend on a host Python installation")
ok("soduwork-database-backup.timer" in installer and "soduwork-restore-drill.timer" in installer
   and "soduwork-backup-health.timer" in installer,
   "operations installer does not enable the complete backup schedule")

print(f"release ops: {checks} checks passed")
result = unittest.TextTestRunner(verbosity=2).run(
    unittest.defaultTestLoader.loadTestsFromNames(["test_ops_cli", "test_release_transactions"]))
if not result.wasSuccessful():
    raise SystemExit(1)
