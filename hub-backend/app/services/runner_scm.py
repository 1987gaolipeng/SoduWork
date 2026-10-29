"""Runner-side clean SCM mirror for networks the Hub cannot reach directly."""
from __future__ import annotations

import hashlib
import os

from . import git_ops
from .local_base import _data_root


def _repo_dir(url: str) -> str:
    key = hashlib.sha256(str(url or "").strip().encode("utf-8")).hexdigest()[:24]
    return os.path.join(_data_root(), "scm", key)


def _ready(payload: dict) -> tuple[str, dict]:
    url = str(payload.get("gitUrl") or "").strip()
    creds = dict(payload.get("git") or {})
    ref = str(payload.get("taskId") or "scm")
    if not url:
        return "", {"ok": False, "error": "工程没有配置仓库地址"}
    repo_dir = _repo_dir(url)
    ready = git_ops.ensure_server_repo(repo_dir, url, creds, ref)
    return repo_dir, ready


def inspect_sync(payload: dict) -> dict:
    """Verify a pushed branch from a clean Runner-local mirror."""
    repo_dir, ready = _ready(payload)
    if not ready.get("ok"):
        return ready
    branch = str(payload.get("branch") or "")
    target = str(payload.get("target") or "")
    result = git_ops.branch_commits(
        repo_dir, str(payload.get("branch") or ""),
        str(payload.get("target") or ""), 20, True,
        dict(payload.get("git") or {}), str(payload.get("taskId") or "scm"))
    if result.get("ok") and not result.get("commits"):
        result["merged"] = git_ops.branch_merged(
            repo_dir, branch, target, False,
            dict(payload.get("git") or {}), str(payload.get("taskId") or "scm"))
    return result


def probe_sync(payload: dict) -> dict:
    """Read-only connectivity check for the configured target branch.

    Cloning/fetching happens in the same clean Runner mirror used later for inspection and merge;
    this proves the Runner's network route and the project owner's credentials, not the Hub's.
    """
    repo_dir, ready = _ready(payload)
    if not ready.get("ok"):
        return ready
    target = str(payload.get("target") or "").strip()
    checked = git_ops.probe_remote_branch(
        repo_dir, target, dict(payload.get("git") or {}),
        str(payload.get("taskId") or "scm-probe"))
    if not checked.get("ok"):
        return {"ok": False, "error": checked.get("error") or "目标分支不可读"}
    return {**checked, "createdMirror": bool(ready.get("created"))}


def merge_sync(payload: dict) -> dict:
    """Merge an approved branch in the clean mirror and push the target."""
    repo_dir, ready = _ready(payload)
    if not ready.get("ok"):
        return ready
    return git_ops.merge_to(
        repo_dir, str(payload.get("branch") or ""),
        str(payload.get("target") or ""),
        dict(payload.get("git") or {}), str(payload.get("taskId") or "scm"))
