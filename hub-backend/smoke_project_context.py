# -*- coding: utf-8 -*-
"""Isolated smoke for versioned project context and accepted task memory."""
import asyncio
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
DB = ROOT / ".smoke-project-context.db"
WORK = ROOT / ".smoke-project-context-work"


def remove_worktree():
    def writable_then_retry(operation, path, _error):
        os.chmod(path, stat.S_IWRITE)
        operation(path)
    if WORK.exists():
        shutil.rmtree(WORK, onerror=writable_then_retry)


for suffix in ("", "-shm", "-wal"):
    try:
        Path(str(DB) + suffix).unlink()
    except FileNotFoundError:
        pass
remove_worktree()
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.as_posix()
sys.path.insert(0, str(ROOT))

from sqlalchemy import select  # noqa: E402

from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.project_context_models import (  # noqa: E402
    ProjectContextSnapshot, ProjectMemoryCapsule, TaskContextEnvelope)
from app.services import (  # noqa: E402
    project_context, project_context_runtime, task_status, task_trace)

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + (" << " + str(detail)[:300] if detail else ""))


def git(*args):
    return subprocess.run(
        ["git", "-C", str(WORK), *args], check=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8")


def make_repo():
    WORK.mkdir(parents=True)
    (WORK / "AGENTS.md").write_text(
        "# Project rules\nKeep changes small. Run npm test.\n"
        "API_KEY=super-secret-value\n", encoding="utf-8")
    (WORK / "README.md").write_text(
        "# Context fixture\nThis service produces reviewed reports.\n",
        encoding="utf-8")
    (WORK / "package.json").write_text(
        '{"scripts":{"test":"node --test","build":"node build.mjs"}}',
        encoding="utf-8")
    git("init", "-b", "main")
    git("config", "user.name", "SoduWork Smoke")
    git("config", "user.email", "smoke@soduwork.local")
    git("add", ".")
    git("commit", "-m", "fixture")


async def seed(session):
    project = models.Project(
        id="p-context", name="SoduWork", desc="Enterprise AI platform",
        org_id="org-context", owner_user_id="u-context")
    repo = models.Repo(
        id="r-context", project_id=project.id, org_id=project.org_id,
        name="SoduWork monorepo", kind="backend", git_url="https://example/repo.git",
        default_branch="main", merge_branch="main", ai_work_dir=str(WORK),
        note="Use the repository tests before delivery.")
    task = models.Task(
        id="t-context-1", title="Preserve project understanding",
        note="Open a fresh Agent session without losing approved context.",
        status="doing", owner_client_id="", project_id=project.id, repo_id=repo.id)
    session.add_all([project, repo, task])
    await session.commit()
    return project, repo, task


async def main():
    make_repo()
    await init_db()
    async with SessionLocal() as session:
        project, repo, task = await seed(session)
        extra = await project_context.attach(session, {}, task, repo)
        descriptor = extra.get("projectContext") or {}
        report = project_context_runtime.prepare(
            str(WORK), descriptor, {"branch": "main"})
        prompt = str(report.get("prompt") or "")
        check("portable descriptor contains project identity",
              descriptor.get("projectId") == project.id
              and descriptor.get("repoId") == repo.id, descriptor)
        check("descriptor exposes a versioned cross-agent memory contract",
              descriptor.get("memory", {}).get("schemaVersion") == "project-memory.v2"
              and descriptor.get("memory", {}).get("scope", {}).get("repoId") == repo.id,
              descriptor.get("memory"))
        check("runtime reads repository rules and manifests",
              report.get("state") == "ready"
              and report.get("sourceCount", 0) >= 3
              and "AGENTS.md" in prompt, report)
        check("runtime records exact git baseline",
              len(str(report.get("baselineCommit") or "")) == 40
              and report.get("branch") == "main", report)
        check("secret values are redacted",
              "super-secret-value" not in prompt and "[redacted]" in prompt)
        check("absolute executor path is never injected",
              str(WORK).lower() not in prompt.lower())
        missing_dir = project_context_runtime.prepare(
            "", descriptor, {"branch": "main"})
        check("empty work directory never falls back to the process directory",
              missing_dir.get("state") == "failed"
              and not missing_dir.get("fingerprint"), missing_dir)

        await project_context.record_dispatch(
            session, task, {"issueId": "ref-context-1",
                            "contextReport": report})
        await project_context.record_completion(
            session, task, SimpleNamespace(ref="ref-context-1"), {
                "done": True,
                "finalText": (
                    r"Implemented bounded project context and verified tests. "
                    r"password=memory-secret C:\Users\operator\private.txt"),
                "attachments": [{"filename": "context-report.md"}],
                "gitHead": report["baselineCommit"],
                "gitBranch": "main",
                "workspaceGuard": {"ok": True},
                "executionPolicyGuard": {"status": "passed"},
                "contextReport": report,
            }, {"files": 1, "missing": []})
        await session.commit()

        envelope = await session.get(TaskContextEnvelope, task.id)
        snapshot = await session.get(
            ProjectContextSnapshot, envelope.snapshot_id if envelope else "")
        capsule = (await session.execute(select(ProjectMemoryCapsule).where(
            ProjectMemoryCapsule.task_id == task.id))).scalar_one_or_none()
        check("dispatch persists immutable snapshot and task envelope",
              bool(envelope and snapshot)
              and envelope.fingerprint == report.get("fingerprint"),
              envelope.payload if envelope else {})
        check("completed execution creates reviewable candidate memory",
              capsule is not None and capsule.state == "candidate"
              and capsule.commit_sha == report["baselineCommit"],
              capsule.state if capsule else "")
        check("durable memory hides credentials and executor paths",
              "memory-secret" not in capsule.summary
              and "operator" not in capsule.summary
              and "[redacted]" in capsule.summary
              and "[本机路径已隐藏]" in capsule.summary, capsule.summary)

        capsule_prompt = project_context_runtime._prompt(
            descriptor, [], [project_context_runtime._clean_capsule({
                "id": "leaky", "title": "Prior delivery",
                "summary": r"token=runtime-secret C:\Users\runner\work",
            })])
        check("runner sanitizes accepted memory again before injection",
              "runtime-secret" not in capsule_prompt
              and "runner" not in capsule_prompt, capsule_prompt)

        await project_context.record_completion(
            session, task, SimpleNamespace(ref="ref-context-failed"), {
                "done": False, "error": "temporary executor failure",
            }, {})
        await session.flush()
        failed_capsule = (await session.execute(select(ProjectMemoryCapsule).where(
            ProjectMemoryCapsule.execution_ref == "ref-context-failed"
        ))).scalar_one_or_none()
        check("failed execution remains diagnostic and can never become shared memory",
              failed_capsule is not None and failed_capsule.state == "failed")

        pending_task = models.Task(
            id="t-context-pending", title="Unreviewed follow-up", status="todo",
            owner_client_id="", project_id=project.id, repo_id=repo.id)
        session.add(pending_task)
        await session.flush()
        pending_extra = await project_context.attach(session, {}, pending_task, repo)
        check("unreviewed memory never enters a fresh Agent session",
              pending_extra["projectContext"]["priorCapsules"] == [])

        changed = await task_status.mark(
            session, task, "done", why="smoke acceptance", allow_incomplete=True)
        await session.commit()
        await session.refresh(capsule)
        await session.refresh(failed_capsule)
        check("task acceptance promotes memory",
              changed and capsule.state == "accepted" and capsule.reviewed_at is not None
              and failed_capsule.state == "failed")

        next_task = models.Task(
            id="t-context-2", title="Next task", status="todo",
            owner_client_id="", project_id=project.id, repo_id=repo.id)
        session.add(next_task)
        await session.flush()
        next_extra = await project_context.attach(session, {}, next_task, repo)
        next_view = await project_context.task_view(session, next_task)
        check("new Agent session receives only accepted prior memory",
              len(next_extra["projectContext"]["priorCapsules"]) == 1
              and "bounded project context" in
              next_extra["projectContext"]["priorCapsules"][0]["summary"])
        accepted_memory = next_extra["projectContext"]["priorCapsules"][0]
        check("accepted memory carries delivery facts across agents",
              "context-report.md" in accepted_memory.get("files", [])
              and any("\u901a\u8fc7" in value for value in accepted_memory.get("checks", [])),
              accepted_memory)
        check("not-yet-dispatched project task has a stable available state",
              next_view.get("state") == "available"
              and next_view.get("stateLabel") == "执行时准备", next_view)
        await session.refresh(task)
        view = await project_context.task_view(session, task)
        full = await task_trace.trace(session, task)
        check("shared project context projection is concise",
              view.get("memoryCount") == 1 and view.get("sourceCount", 0) >= 3
              and "prompt" not in str(view), view)
        check("task detail, AI work and approval share context",
              full.get("projectContext", {}).get("fingerprint") ==
              report.get("fingerprint"), full.get("projectContext"))


async def run():
    try:
        await main()
    finally:
        await engine.dispose()
        remove_worktree()
        for suffix in ("", "-shm", "-wal"):
            try:
                Path(str(DB) + suffix).unlink()
            except FileNotFoundError:
                pass
    print("\nproject context smoke: %d passed, %d failed" % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(run())
