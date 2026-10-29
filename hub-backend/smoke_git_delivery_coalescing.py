"""Regression checks for terminal-status Git inspection coalescing."""
from __future__ import annotations

import os
import tempfile
import threading
import time

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///.smoke-git-delivery.db"

from app.services import ai_local, git_ops, workflow_engine


passed = 0


def check(value, message: str) -> None:
    global passed
    assert value, message
    passed += 1


old_identity = git_ops.worktree_identity
old_save = ai_local._save_meta
try:
    calls = []

    def empty_identity(_cwd: str) -> dict:
        calls.append("called")
        return {}

    git_ops.worktree_identity = empty_identity
    ai_local._save_meta = lambda _ref: None
    run = {"ref": "coalesce-empty", "state": "done", "ws": "Z:/missing"}
    first = ai_local._git_delivery(run)
    second = ai_local._git_delivery(run)
    check(first.get("_checked") is True, "empty Git inspection must be marked checked")
    check(second.get("_checked") is True, "empty Git inspection cache must be reused")
    check(len(calls) == 1, "empty Git result must not be retried on every status poll")

    entered = threading.Event()
    release = threading.Event()
    calls.clear()

    def slow_identity(_cwd: str) -> dict:
        calls.append("called")
        entered.set()
        release.wait(3)
        return {"branch": "task/demo", "remoteBranch": "task/demo", "head": "abc"}

    git_ops.worktree_identity = slow_identity
    run = {"ref": "coalesce-slow", "state": "done", "ws": "Z:/slow"}
    result = {}
    worker = threading.Thread(target=lambda: result.update(ai_local._git_delivery(run)))
    worker.start()
    check(entered.wait(1), "first Git inspection must start")
    started = time.monotonic()
    concurrent = ai_local._git_delivery(run)
    elapsed = time.monotonic() - started
    check(concurrent == {"_pending": True},
          "concurrent status poll must expose pending Git evidence without duplicating inspection")
    check(elapsed < 0.2, "concurrent status poll must return without waiting for slow Git")
    release.set()
    worker.join(2)
    check(not worker.is_alive(), "first Git inspection must finish")
    check(len(calls) == 1, "only one Git inspection may run per execution")
    check(result.get("remoteBranch") == "task/demo", "successful result must be cached")

    # The provider contract must preserve the transient marker so the workflow
    # engine can defer settlement instead of reporting a false missing output.
    release = threading.Event()
    entered = threading.Event()

    def status_identity(_cwd: str) -> dict:
        entered.set()
        release.wait(3)
        return {"branch": "task/status", "remoteBranch": "task/status", "head": "def"}

    git_ops.worktree_identity = status_identity
    ref = "coalesce-status"
    ai_local._RUNS[ref] = {
        "ref": ref, "state": "done", "ws": "Z:/status", "title": "code task",
        "artifactMode": "git", "codeTask": True, "lines": [], "segment": 1,
        "round": 1, "seen": set(), "workspaceGuard": {}, "artDropped": 0,
    }
    worker = threading.Thread(target=lambda: ai_local._git_delivery(ai_local._RUNS[ref]))
    worker.start()
    check(entered.wait(1), "status Git inspection must start")
    status = ai_local.status_sync({}, ref)
    check(status.get("gitDeliveryPending") is True,
          "terminal provider status must expose pending Git evidence")
    check(not status.get("gitBranch") and not status.get("gitHead"),
          "pending Git evidence must not invent a branch or commit")
    check(workflow_engine._git_delivery_pending(status, {
        "declared": [{"key": "code", "kind": "git"}]}),
          "workflow settlement must wait while required Git evidence is pending")
    check(not workflow_engine._git_delivery_pending(status, {
        "declared": [{"key": "report", "kind": "text"}]}),
          "pending Git evidence must not delay non-Git output contracts")
    release.set()
    worker.join(2)
    ai_local._RUNS.pop(ref, None)

    with tempfile.TemporaryDirectory() as folder:
        ref = "files-no-git"
        ai_local._RUNS[ref] = {
            "ref": ref, "state": "done", "ws": folder, "title": "office task",
            "artifactMode": "files", "codeTask": False, "lines": [], "segment": 1,
            "round": 1, "seen": set(), "workspaceGuard": {}, "artDropped": 0,
        }
        git_ops.worktree_identity = lambda _cwd: (_ for _ in ()).throw(
            AssertionError("files task must not inspect Git"))
        status = ai_local.status_sync({}, ref)
        check(status.get("ok") is True, "files task terminal status must remain available")
        check(status.get("deliveryKind") == "files", "files delivery kind must be preserved")
        ai_local._RUNS.pop(ref, None)
finally:
    git_ops.worktree_identity = old_identity
    ai_local._save_meta = old_save
    ai_local._RUNS.pop("files-no-git", None)
    ai_local._RUNS.pop("coalesce-status", None)

print("PASS", passed)
