"""Repository mutation guard for read-only workflow nodes.

Scope/review nodes may inspect and build a repository, but their only durable writes are
the explicitly declared output files.  Prompts are guidance; this module is the hard gate.
"""
from __future__ import annotations

import subprocess


_TIMEOUT = 30


def _git(cwd: str, *args: str) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["git", "-c", "http.proxy=", "-c", "https.proxy=", *args],
            cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=_TIMEOUT, check=False,
        )
        return proc.returncode, ((proc.stdout or "") + (proc.stderr or "")).strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, type(exc).__name__


def _identity(cwd: str) -> tuple[str, str, str]:
    head_code, head = _git(cwd, "rev-parse", "HEAD")
    branch_code, branch = _git(cwd, "branch", "--show-current")
    if head_code or branch_code:
        return "", "", "当前目录不是可检查的 Git 工作树"
    return head.strip(), branch.strip(), ""


def _changed(cwd: str) -> tuple[list[str], str]:
    diff_code, diff = _git(cwd, "diff", "--name-only", "HEAD", "--")
    other_code, other = _git(cwd, "ls-files", "--others", "--exclude-standard", "--")
    if diff_code or other_code:
        return [], "无法读取 Git 工作树变化"
    paths = {line.strip().replace("\\", "/") for line in (diff + "\n" + other).splitlines()
             if line.strip()}
    return sorted(paths), ""


def _safe_path(value: str) -> str:
    path = str(value or "").strip().replace("\\", "/").lstrip("/")
    parts = [part for part in path.split("/") if part not in ("", ".")]
    if not parts or ".." in parts:
        return ""
    return "/".join(parts)


def _allowed(outputs: list | None) -> list[str]:
    return sorted({path for item in (outputs or []) if isinstance(item, dict)
                   for path in [_safe_path(item.get("path") or "")] if path})


def _is_allowed(path: str, allowed: list[str]) -> bool:
    return any(path == item or path.startswith(item.rstrip("/") + "/") for item in allowed)


def capture(cwd: str, policy: dict | None, outputs: list | None) -> dict:
    policy = dict(policy or {})
    if str(policy.get("mutation") or "") != "outputs-only":
        return {}
    head, branch, error = _identity(cwd)
    changed, changed_error = _changed(cwd) if not error else ([], "")
    error = error or changed_error
    allowed = _allowed(outputs)
    if not allowed:
        error = error or "文件型节点没有声明可写产出路径"
    if changed:
        error = error or "隔离工作树在执行前已经不干净"
    return {
        "enabled": True,
        "mode": "outputs-only",
        "ok": not error,
        "baselineHead": head,
        "baselineBranch": branch,
        "allowedPaths": allowed,
        "changedPaths": changed,
        "violatingPaths": changed,
        "reason": error,
    }


def evaluate(cwd: str, baseline: dict | None) -> dict:
    baseline = dict(baseline or {})
    if not baseline.get("enabled"):
        return {}
    head, branch, error = _identity(cwd)
    changed, changed_error = _changed(cwd) if not error else ([], "")
    error = error or changed_error
    allowed = [p for p in (baseline.get("allowedPaths") or []) if _safe_path(p)]
    violating = [path for path in changed if not _is_allowed(path, allowed)]
    identity_changed = bool(
        head and head != str(baseline.get("baselineHead") or "")
        or branch != str(baseline.get("baselineBranch") or "")
    )
    reasons = []
    if error:
        reasons.append(error)
    if identity_changed:
        reasons.append("文件型节点改变了分支或提交")
    if violating:
        preview = "、".join(violating[:8])
        reasons.append("文件型节点越权修改仓库" + ("：" + preview if preview else ""))
    return {
        **baseline,
        "ok": not reasons,
        "currentHead": head,
        "currentBranch": branch,
        "changedPaths": changed[:80],
        "violatingPaths": violating[:80],
        "identityChanged": identity_changed,
        "reason": "；".join(reasons),
    }
