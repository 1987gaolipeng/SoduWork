"""Static safety contract for full backup operations and restore drills."""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
backup = (ROOT / "ops" / "backup" / "full-backup.sh").read_text(encoding="utf-8")
drill = (ROOT / "ops" / "backup" / "restore-drill.sh").read_text(encoding="utf-8")
override = (ROOT / "ops" / "backup" / "compose.backup.override.yml").read_text(encoding="utf-8")
dockerfile = (ROOT / "Dockerfile.server").read_text(encoding="utf-8")
checks = 0


def ok(condition: bool, message: str) -> None:
    global checks
    checks += 1
    assert condition, message


ok(backup.startswith("#!/usr/bin/env bash\nset -euo pipefail\numask 077"),
   "backup must fail closed with protected defaults")
ok("SODUWORK_BACKUP_KEY_FILE" in backup and "--key-file" in backup,
   "backup encryption key is not mandatory")
ok("python full_backup.py create" in backup and "python full_backup.py verify" in backup,
   "backup is not deeply verified before success")
ok('if [[ "$VERIFIED" != 1 ]]' in backup
   and 'rm -f -- "$OUTPUT" "$OUTPUT.manifest.json" "$RECEIPT"' in backup,
   "unverified backup artifacts are not removed")
ok("--source system=" in backup and "--source uploads=" in backup,
   "system configuration or uploads are missing")
ok("--source runner=" in backup and "--source deployments=" in backup,
   "Runner or deployment state is missing")
ok("--source server-releases=" in backup and "--source hub-data=" in backup,
   "server release or Hub persistent data is missing")
ok("managed-apps" not in backup and "data/apps" not in override,
   "live managed application databases must use their own backup adapter")
ok("./data/runner/data:/srv/app/backup-sources/runner:ro" in override
   and "./data/deployments" in override,
   "Runner data or deployment state is not mounted from the release data root")
ok("RETAIN_COUNT" in backup and "soduwork-full-*.sfb" in backup,
   "retention is not explicit and scoped")
ok("org.opencontainers.image.revision" in backup
   and 'RELEASE="$(cat DEPLOYED_RELEASE' not in backup,
   "backup release identity is not taken from the running immutable image")
ok(drill.startswith("#!/usr/bin/env bash\nset -euo pipefail\numask 077"),
   "restore drill must fail closed")
ok("soduwork_restore_drill_" in drill and "dropdb" in drill,
   "restore drill is not isolated and self-cleaning")
ok("pg_restore --exit-on-error" in drill,
   "restore drill does not fail on database restore errors")
ok("tableCounts" in drill and "select count(*)" in drill,
   "restored database rows are not compared with the snapshot inventory")
ok("EXPECTED_TABLES" in drill and '"$TABLES" -eq "$EXPECTED_TABLES"' in drill,
   "restore drill may report success without comparing every table")
ok("</dev/null" in drill,
   "database commands may consume the remaining expected-count input")
ok('"productionChanged": False' in drill,
   "restore receipt does not explicitly record production isolation")
ok('rm -f -- "$RECEIPT"' in drill,
   "a failed new drill may leave a stale successful receipt")
ok("PG_USER=" in drill and "-U soduwork" not in drill,
   "restore drill must use the environment-specific PostgreSQL user")
ok(set(re.findall(r"/opt/[A-Za-z0-9_-]+", backup + drill + override)) == {"/opt/soduwork"}
   and all('${SODUWORK_ROOT:-/opt/soduwork}' in script for script in (backup, drill)),
   "backup operations must use the canonical default and allow a deployment root override")
ok("postgresql-client-16" in dockerfile,
   "backup image is not pinned to the PostgreSQL 16 client")
ok("python:3.12-slim-bookworm" in dockerfile,
   "Python base image may silently drift across Debian releases")
ok("192.0.2.149" not in backup + drill and not re.search(r"\bsoduwork_pro\b", backup + drill),
   "backup operations are coupled to the validation environment")

print(f"full backup ops: {checks} checks passed")
