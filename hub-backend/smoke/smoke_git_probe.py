# -*- coding: utf-8 -*-
"""Gerrit/Git preflight must be bounded, current, and fail closed."""
from __future__ import annotations

import os
import subprocess
import tempfile

from app.services import git_ops

ok = fail = 0


def chk(name, value, extra=""):
    global ok, fail
    if value:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, extra)


original_git = git_ops._git
try:
    calls = []

    def good(_cwd, *args, **kwargs):
        calls.append((args, kwargs))
        if args[0] == "fetch":
            return 0, ""
        return 0, "abc123\n"

    git_ops._git = good
    result = git_ops.probe_remote_branch(
        "mirror", "develop", {"token": "secret"}, "p1")
    chk("probe fetches only the target branch",
        calls[0][0] == (
            "fetch", "--no-tags", "origin",
            "+refs/heads/develop:refs/remotes/origin/develop"), calls)
    chk("probe fetch has a dedicated short timeout",
        calls[0][1].get("timeout") == 45, calls)
    chk("successful probe returns an auditable head",
        result == {"ok": True, "target": "develop", "head": "abc123"}, result)

    calls.clear()

    def failed_fetch(_cwd, *args, **kwargs):
        calls.append((args, kwargs))
        return 124, "timeout"

    git_ops._git = failed_fetch
    failed = git_ops.probe_remote_branch(
        "mirror", "develop", {"token": "secret"}, "p2")
    chk("failed fetch stops before reading a stale head",
        not failed.get("ok") and len(calls) == 1, (failed, calls))

    calls.clear()
    stale = git_ops.branch_commits(
        "mirror", "task/demo", "develop", git_creds={"token": "secret"})
    chk("delivery inspection also rejects a failed refresh",
        not stale.get("ok") and len(calls) == 1, (stale, calls))
finally:
    git_ops._git = original_git

original_git = git_ops._git
try:
    ancestry_calls = []

    def ancestry(_cwd, *args, **kwargs):
        ancestry_calls.append(args)
        return (0, "") if args[:2] == ("merge-base", "--is-ancestor") else (1, "")

    git_ops._git = ancestry
    contains = git_ops.branch_contains_target(
        "mirror", "task/demo", "develop", False, {"token": "secret"}, "p3")
    chk("conflict repair proof checks target as candidate ancestor",
        contains and ancestry_calls == [(
            "merge-base", "--is-ancestor", "origin/develop", "origin/task/demo")],
        ancestry_calls)
finally:
    git_ops._git = original_git

class _HungGit:
    pid = 24680
    returncode = None
    stdout = None

    def communicate(self, timeout=None):
        if timeout == 5:
            self.returncode = -9
            return ("", None)
        raise subprocess.TimeoutExpired("git", timeout)


original_popen = git_ops.subprocess.Popen
original_kill_tree = git_ops._kill_process_tree
try:
    hung = _HungGit()
    killed = []
    popen_calls = []

    def fake_popen(*args, **kwargs):
        popen_calls.append(kwargs)
        return hung
    git_ops.subprocess.Popen = fake_popen
    git_ops._kill_process_tree = lambda proc: killed.append(proc.pid)
    timeout_code, timeout_text = git_ops._git("mirror", "fetch", timeout=1)
    chk("timeout kills the full Git process tree",
        timeout_code == 124 and killed == [24680] and "1s" in timeout_text,
        (timeout_code, timeout_text, killed))
    chk("Git never inherits the long-lived Runner stdin",
        popen_calls[0].get("stdin") is subprocess.DEVNULL, popen_calls)
finally:
    git_ops.subprocess.Popen = original_popen
    git_ops._kill_process_tree = original_kill_tree

original_git = git_ops._git
try:
    clone_calls = []

    def timed_out_clone(cwd, *args, **kwargs):
        clone_calls.append((cwd, args, kwargs))
        os.makedirs(os.path.join(args[-1], ".git"), exist_ok=True)
        return 124, "timeout"

    git_ops._git = timed_out_clone
    with tempfile.TemporaryDirectory() as temp:
        mirror = os.path.join(temp, "scm", "fresh-mirror")
        clone_result = git_ops.ensure_server_repo(
            mirror, "https://git.example.test/team/repo.git",
            {"token": "secret"}, "probe-1")
        chk("initial clone uses the bounded process-tree Git runner",
            len(clone_calls) == 1
            and clone_calls[0][1][:2] == (
                "clone", "https://git.example.test/team/repo.git")
            and clone_calls[0][2].get("timeout") == git_ops._TIMEOUT,
            clone_calls)
        chk("timed-out initial clone is retryable",
            not clone_result.get("ok") and not os.path.exists(mirror),
            clone_result)
finally:
    git_ops._git = original_git

poison = {
    "GIT_DIR": "wrong-repository",
    "GIT_CONFIG_COUNT": "99",
    "GIT_CONFIG_KEY_42": "credential.helper",
    "GIT_CONFIG_VALUE_42": "manager",
    "GIT_TRACE": "1",
    "ALL_PROXY": "http://invalid-proxy.local:9",
}
previous = {key: os.environ.get(key) for key in poison}
try:
    os.environ.update(poison)
    controlled = git_ops._env({
        "name": "SoduWork Test",
        "email": "soduwork@example.com",
        "user": "git-user",
        "token": "git-token",
        "gerrit_user": "gerrit-user",
        "gerrit_token": "gerrit-token",
    })
finally:
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
chk("Runner SCM starts from a controlled Git environment",
    all(key not in controlled for key in (
        "GIT_DIR", "GIT_CONFIG_KEY_42", "GIT_CONFIG_VALUE_42",
        "GIT_TRACE", "ALL_PROXY"))
    and controlled.get("GIT_CONFIG_COUNT") != "99"
    and controlled.get("GCM_INTERACTIVE") == "Never"
    and controlled.get("GIT_TERMINAL_PROMPT") == "0", controlled)

print(f"\n{ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
