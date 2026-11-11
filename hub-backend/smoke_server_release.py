"""Static contract for the transactional single-node release script."""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "ops" / "deploy-server.sh"
source = SCRIPT.read_text(encoding="utf-8")
checks = 0


def ok(condition: bool, message: str) -> None:
    global checks
    checks += 1
    assert condition, message


ok(source.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail"),
   "release script must fail closed")
ok("EXPECTED_SHA256" in source and "checksum mismatch" in source,
   "source archive checksum is not enforced")
ok("org.opencontainers.image.revision" in source,
   "release image identity is not verified")
ok("pg_dump" in source and "--format=custom" in source,
   "release does not create a native PostgreSQL backup")
ok("pg_restore --list" in source
   and '[[ -s "${target}" && -s "${target}.list" ]]' in source,
   "database backup is not verified before use")
ok('restore_database "${PROBE_DATABASE}" "${PREFLIGHT_BACKUP}"' in source,
   "production snapshot is not restored into a disposable database")
ok('run_migration "${PROBE_DATABASE}" auto' in source,
   "restored snapshot is not migrated")
ok("environment must set DB_MIGRATION_MODE=check" in source,
   "application containers are allowed to run migrations implicitly")
ok(source.index("done\ndocker compose version")
   < source.index("environment must set DB_MIGRATION_MODE=check"),
   "migration-mode guard is accidentally nested in command discovery")
ok('run_migration "${PROBE_DATABASE}" check' in source,
   "restored snapshot is not checked at migration head")
ok('compose stop "${RUNNER_SERVICE}" "${HUB_SERVICE}"' in source,
   "cutover does not quiesce writers")
ok('backup_database "${CUTOVER_BACKUP}"' in source,
   "cutover has no point-in-time rollback backup")
ok('restore_database "${PG_DATABASE}" "${ROLLBACK_BACKUP}"' in source,
   "failed cutover does not restore the database")
ok('restore_environment "${ENV_BACKUP}"' in source,
   "failed cutover does not restore the previous release identity")
ok('docker tag "${PREVIOUS_IMAGE_ID}" "${IMAGE_REPO}:latest"' in source,
   "failed cutover does not restore the previous image")
ok("--no-build --no-deps --force-recreate" in source,
   "cutover may rebuild or silently reuse containers")
ok("wait_for_health 60" in source,
   "release does not wait for application health")
ok("RUNNING_IMAGE_ID=" in source and "EXPECTED_IMAGE_ID=" in source,
   "release does not verify the running image")
ok("RUNNING_RUNNER_IMAGE_ID=" in source
   and '[[ "${RUNNING_RUNNER_IMAGE_ID}" == "${EXPECTED_IMAGE_ID}" ]]' in source,
   "release does not verify the Runner image")
ok('run_migration "${PG_DATABASE}" check' in source,
   "release does not verify the live database revision")
ok('chmod 600 "${MIGRATION_ENV}"' in source and 'rm -f "${MIGRATION_ENV}"' in source,
   "temporary credential environment is not protected and removed")
ok("docker inspect --format" in source and "docker inspect ${" not in source,
   "container inspection must request explicit non-secret fields")
ok("192.0.2.149" not in source and not re.search(r"\bsoduwork_pro\b", source),
   "release script contains validation-environment coupling")
ok("CRITICAL: automatic rollback did not complete" in source,
   "rollback failure is not surfaced as a critical condition")
ok('backup_environment "${ENV_BACKUP}"' in source
   and 'chmod 600 "${target}"' in source,
   "release identity environment has no protected rollback backup")
ok('write_release_environment "${RELEASE_TAG}" "${RELEASED_AT_UTC}"' in source,
   "release does not atomically publish its runtime identity")
ok("wait_for_release_health 60" in source
   and ('\\"commit\\":\\"${release}\\"' in source
        or '\\"commit\\":\\"${RELEASE_TAG}\\"' in source)
   and ('\\"deployedAt\\":\\"${deployed_at}\\"' in source
        or '\\"deployedAt\\":\\"${RELEASED_AT_UTC}\\"' in source),
   "release health check does not require exact identity and deployment time")
ok("environment_backup=${ENV_BACKUP}" in source
   and "released_at_utc=${RELEASED_AT_UTC}" in source,
   "release manifest does not preserve the exact environment rollback point")
entrypoint_refresh = (
    'install -m 0755 "${SOURCE_DIR}/ops/deploy-server.sh" "${OPS_SCRIPT_TEMP}"' in source
    and 'mv -f "${OPS_SCRIPT_TEMP}" "${OPS_ENTRYPOINT}"' in source
) or ('${SOURCE_DIR}/ops/install-operations.sh" --root "${ROOT_DIR}" --skip-state-init' in source)
ok(entrypoint_refresh,
   "successful release does not refresh the fixed operational entrypoint")

print(f"server release: {checks} checks passed")
