# -*- coding: utf-8 -*-
"""Workflow executors receive a compact current view, not all audit history."""
import asyncio
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

DB = os.path.abspath(".smoke-workflow-inputs.db")
DATA = os.path.abspath(".smoke-workflow-inputs-data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import storage, workflow_inputs  # noqa: E402


async def main() -> int:
    await init_db()
    passed = failed = 0

    def check(name, condition, detail=None):
        nonlocal passed, failed
        if condition:
            passed += 1
            print("  PASS  " + name)
        else:
            failed += 1
            print("  FAIL  " + name + ((" :: " + repr(detail))
                                        if detail is not None else ""))

    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        rows = []
        fixtures = [
            ("review-old", "code-review.json", b"old review", 0),
            ("req-old", "requirements.md", b"old requirements", 1),
            ("review-new", "./code-review.json", b"current review", 2),
            ("req-new", "requirements.md", b"current requirements", 3),
            ("user", "inputs/example.txt", b"user material", 4),
        ]
        for attachment_id, filename, data, offset in fixtures:
            key = "smoke/" + attachment_id
            backend = storage.put(key, data, "text/plain")
            rows.append(models.Attachment(
                id=attachment_id, task_id="task-inputs", filename=filename,
                content_type="text/plain", size=len(data), storage_key=key,
                backend=backend, role="output", source_ref="ref-" + attachment_id,
                created_at=now + timedelta(seconds=offset)))
        session.add_all(rows)
        await session.commit()

        current = await workflow_inputs.all_files(session, "task-inputs")
        check("latest logical filename wins", current == [
            ("./code-review.json", b"current review", "text/plain"),
            ("requirements.md", b"current requirements", "text/plain"),
            ("inputs/example.txt", b"user material", "text/plain"),
        ], current)
        check("audit rows remain append-only", len(rows) == 5)

        executor = await workflow_inputs.all_files(
            session, "task-inputs", exclude_names={"code-review.json"})
        check("review control output is not replayed", executor == [
            ("requirements.md", b"current requirements", "text/plain"),
            ("inputs/example.txt", b"user material", "text/plain"),
        ], executor)
        check("basename exclusion also covers relative paths",
              all("code-review" not in name for name, _, _ in executor))

        requirements = b"""# Change baseline
## Acceptance criteria
### A. Data migration
- [A1] Existing records are preserved.
- [A2] New records receive a project number.
### B. API contract
- [B1] The response remains backwards compatible.
## Notes
- This note is not an acceptance criterion.
"""
        key = "smoke/requirements-labeled"
        backend = storage.put(key, requirements, "text/markdown")
        session.add(models.Attachment(
            id="req-labeled", task_id="task-labeled", filename="requirements.md",
            content_type="text/markdown", size=len(requirements), storage_key=key,
            backend=backend, role="output", source_ref="ref-labeled",
            created_at=now + timedelta(seconds=10)))
        await session.commit()
        manifest = await workflow_inputs.requirement_manifest(
            session, SimpleNamespace(id="task-labeled"), {})
        check("nested acceptance groups stay in the acceptance section",
              manifest["acceptanceCriteria"] == [
                  "Existing records are preserved.",
                  "New records receive a project number.",
                  "The response remains backwards compatible.",
              ], manifest["acceptanceCriteria"])
        check("same-level unrelated heading closes the acceptance section",
              all("note" not in item.lower()
                  for item in manifest["acceptanceCriteria"]))

    await engine.dispose()
    shutil.rmtree(DATA, ignore_errors=True)
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    print("%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
