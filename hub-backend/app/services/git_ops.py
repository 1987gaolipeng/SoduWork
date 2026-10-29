"""Shared clean Git mirror operations for Runner execution and legacy colocated Hub deployment.
Keep Runner mirrors in data/scm/<fingerprint>, separate from AI workspaces; server_dir serves
only legacy deployment. Accept credentials only in memory and never persist them in repository
configuration. Disable interactive Git prompts, connect directly to repositories, restrict merge
candidates to task-related branch names, and bound every command with a timeout. Return command
output for the task timeline and verification."""
from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess

_TIMEOUT = 180
# Project preflight only answers whether this Runner can read the target branch.
# Keep it well inside one Runner RPC; clone and merge retain the full timeout above.
_PROBE_TIMEOUT = 45
_SAFE_BRANCH = re.compile(r"^[A-Za-z0-9._\-/]{1,120}$")
_INHERITED_GIT_ENV = {
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SHALLOW_FILE", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR",
    "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS",
    "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "GCM_INTERACTIVE",
    "GIT_CREDENTIAL_MANAGER_INTERACTIVE", "GIT_HTTP_LOW_SPEED_LIMIT",
    "GIT_HTTP_LOW_SPEED_TIME", "GIT_PROXY_COMMAND", "GIT_PROTOCOL",
    "GIT_OPTIONAL_LOCKS", "GIT_FLUSH",
}
_PROXY_ENV = {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "RSYNC_PROXY"}


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """Stop the command and every child that may still own its output pipe.

    Git for Windows commonly starts another ``git.exe``. Killing only the shim
    leaves that child alive with stdout inherited, so ``communicate`` can wait
    forever even though the timeout already fired. ``taskkill /T`` is available
    on supported Windows versions and provides the process-tree boundary; POSIX
    commands run in their own session and are stopped by process group.
    """
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:  # noqa: BLE001 - timeout cleanup must remain best effort
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def _env(git_creds: dict | None = None, ref: str = "") -> dict:
    e = dict(os.environ)
    for key in list(e):
        upper = key.upper()
        if (upper in _INHERITED_GIT_ENV or upper in _PROXY_ENV
                or upper.startswith("GIT_CONFIG_")
                or upper.startswith("GIT_TRACE")):
            e.pop(key, None)
    e["GIT_TERMINAL_PROMPT"] = "0"      # Disable credential prompts to prevent unattended commands from hanging.
    e["GIT_ASKPASS"] = ""
    e["SSH_ASKPASS"] = ""
    e["SSH_ASKPASS_REQUIRE"] = "never"
    e["GCM_INTERACTIVE"] = "Never"
    e["GIT_CREDENTIAL_MANAGER_INTERACTIVE"] = "never"
    if git_creds:
        from .code_creds import env_for
        env_for(e, git_creds, ref=ref)
    return e


def _git(cwd: str, *args: str, git_creds: dict | None = None,
         ref: str = "", timeout: float | None = None) -> tuple[int, str]:
    """Run Git and return its exit code and combined output, explicitly bypassing HTTP proxies."""
    # Supply commit identity explicitly for merge operations.
    # Server processes may have no global Git identity configured.
    cmd = ["git", "--no-pager", "-c", "http.proxy=", "-c", "https.proxy=",
           "-c", "user.name=SoduWork", "-c", "user.email=soduwork@local", *args]
    limit = max(1.0, float(timeout if timeout is not None else _TIMEOUT))
    proc: subprocess.Popen | None = None
    try:
        process_opts = {}
        if os.name == "nt":
            process_opts["creationflags"] = (
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
        else:
            process_opts["start_new_session"] = True
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=_env(git_creds, ref),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            **process_opts,
        )
        output, _ = proc.communicate(timeout=limit)
        return proc.returncode, (output or "").strip()
    except subprocess.TimeoutExpired:
        if proc is not None:
            _kill_process_tree(proc)
            try:
                proc.communicate(timeout=5)
            except Exception:  # noqa: BLE001
                # Never wait on an inherited pipe after the bounded cleanup.
                if proc.stdout:
                    proc.stdout.close()
        return 124, f"超时（>{limit:g}s）：git {' '.join(args)}"
    except FileNotFoundError:
        return 127, "这台机器上没有 git"
    except Exception as e:  # noqa: BLE001
        return 1, f"git 跑不起来（{type(e).__name__}）"
    finally:
        if git_creds and git_creds.get("key") and ref:
            from .code_creds import forget_key
            forget_key(ref)


def worktree_identity(cwd: str) -> dict:
    """Return the checked-out commit and an exact remote branch pointing at it.

    A verification-only task may check out a task-local alias at an existing remote
    commit.  Reporting only the local alias makes delivery discovery search for a
    branch that was never meant to be pushed.  The remote branch is only a hint;
    ``branch_commits`` still fetches and verifies its head before it becomes evidence.
    """
    if not cwd or not os.path.isdir(cwd):
        return {}
    branch_code, branch = _git(cwd, "branch", "--show-current")
    head_code, head = _git(cwd, "rev-parse", "HEAD")
    if branch_code != 0 or head_code != 0:
        return {}
    branch, head = branch.strip(), head.strip()
    upstream_code, upstream = _git(
        cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    upstream = upstream.strip().replace("origin/", "", 1) if upstream_code == 0 else ""
    # A detached worktree can expose the remote namespace itself as "origin".
    # It is not a pushable branch. Keeping it would later make delivery
    # verification compare against the invalid ref "origin/origin".
    if upstream == "origin":
        upstream = ""
    refs_code, refs = _git(
        cwd, "for-each-ref", "--format=%(refname:short)%09%(objectname)",
        "refs/remotes/origin")
    exact = []
    if refs_code == 0:
        for line in refs.splitlines():
            name, _, sha = line.strip().partition("\t")
            name = name.replace("origin/", "", 1)
            if (sha.lower() == head.lower() and name not in {"HEAD", "origin"}
                    and _SAFE_BRANCH.match(name or "")):
                exact.append(name)
    remote = branch if branch in exact else upstream if upstream in exact else ""
    if not remote and exact:
        feature = [name for name in exact if name not in {"main", "master", "develop", "dev"}]
        remote = sorted(feature or exact)[0]
    return {"branch": branch[:160], "head": head[:80], "remoteBranch": remote[:160]}


def worktree_pending_changes(cwd: str) -> dict:
    """Inspect whether a task worktree still contains uncommitted delivery work.

    This is intentionally read-only and bounded. It is used only after a suspicious
    successful CLI exit, so ordinary status polling does not pay for another Git call.
    """
    if not cwd or not os.path.isdir(cwd):
        return {"ok": False, "dirty": False, "count": 0}
    code, output = _git(
        cwd, "status", "--porcelain=v1", "--untracked-files=normal", timeout=15)
    if code != 0:
        return {"ok": False, "dirty": False, "count": 0}
    rows = [line for line in output.splitlines() if line.strip()]
    return {"ok": True, "dirty": bool(rows), "count": len(rows)}


def ensure_server_repo(server_dir: str, git_url: str, git_creds: dict | None = None,
                       ref: str = "") -> dict:
    """Ensure the Hub's clean merge clone exists; credentials never enter argv."""
    raw_path = str(server_dir or "").strip()
    url = str(git_url or "").strip()
    if not raw_path or not os.path.isabs(raw_path):
        return {"ok": False, "error": "服务端合并目录不是绝对路径"}
    path = os.path.abspath(raw_path)
    if os.path.isdir(os.path.join(path, ".git")):
        return {"ok": True, "created": False}
    if not url:
        return {"ok": False, "error": "工程没有配置仓库地址"}
    if os.path.exists(path) and (not os.path.isdir(path) or os.listdir(path)):
        return {"ok": False, "error": f"服务端合并目录已存在但不是 Git 仓库：{path}"}
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    code, output = _git(
        parent, "clone", url, path,
        git_creds=git_creds, ref=ref, timeout=_TIMEOUT)
    if code == 0:
        return {"ok": True, "created": True}

    # git clone creates the destination before network/authentication has
    # completed. A timeout or interrupted Runner must not leave that partial
    # directory behind, otherwise every retry fails before Git is attempted.
    # Only remove the exact fresh mirror target under its validated parent.
    if os.path.dirname(path) == os.path.abspath(parent):
        shutil.rmtree(path, ignore_errors=True)
    if code == 124:
        return {"ok": False, "error": f"克隆服务端仓库超时（>{_TIMEOUT}s）"}
    return {"ok": False, "error": output[-500:] or "服务端仓库克隆失败"}


def find_task_branch(server_dir: str, task_id: str, git_creds: dict | None = None,
                     ref: str = "") -> str:
    """Find a remote branch containing the task ID. Return empty rather than guessing when no
    matching branch exists.
    """
    if not task_id:
        return ""
    _git(server_dir, "fetch", "--prune", "origin", git_creds=git_creds, ref=ref)
    code, out = _git(server_dir, "branch", "-r", "--list", f"origin/*{task_id}*",
                     git_creds=git_creds, ref=ref)
    if code != 0:
        return ""
    names = [ln.strip().replace("origin/", "", 1) for ln in out.splitlines() if ln.strip()]
    names = [n for n in names if _SAFE_BRANCH.match(n) and "->" not in n]
    return names[-1] if names else ""


def probe_remote_branch(server_dir: str, target: str,
                        git_creds: dict | None = None, ref: str = "") -> dict:
    """Bounded read-only proof that the Runner can authenticate and read target.

    A probe does not need a commit log or diff. It must also never continue against
    stale remote refs after a failed fetch. Fetching one exact head avoids enumerating
    every Gerrit review ref in repositories with a long review history.
    """
    if not _SAFE_BRANCH.match(target or ""):
        return {"ok": False, "error": "目标分支名不合法", "head": ""}
    remote_ref = f"refs/remotes/origin/{target}"
    code, out = _git(
        server_dir, "fetch", "--no-tags", "origin",
        f"+refs/heads/{target}:{remote_ref}",
        git_creds=git_creds, ref=ref, timeout=_PROBE_TIMEOUT)
    if code != 0:
        detail = (out or "远端没有返回错误详情")[-400:]
        return {"ok": False, "error": "读取远端目标分支失败：" + detail, "head": ""}
    code, head = _git(
        server_dir, "rev-parse", "--verify", remote_ref,
        git_creds=git_creds, ref=ref, timeout=10)
    if code != 0:
        return {
            "ok": False,
            "error": "远端目标分支不存在或不可读：" + head[-300:],
            "head": "",
        }
    return {"ok": True, "target": target, "head": head.strip()}


def branch_commits(server_dir: str, branch: str, target: str,
                   limit: int = 20, fetch: bool = True,
                   git_creds: dict | None = None, ref: str = "") -> dict:
    """Compare pushed remote branch commits and changed files against the remote target.
    fetch=False reuses a recent fetch; unpushed local commits do not establish delivery.
    """
    if not (_SAFE_BRANCH.match(branch or "") and _SAFE_BRANCH.match(target or "")):
        return {"ok": False, "error": "分支名不合法", "commits": [], "files": []}
    if fetch:
        fetch_code, fetch_out = _git(
            server_dir, "fetch", "--prune", "origin", git_creds=git_creds, ref=ref)
        if fetch_code != 0:
            return {
                "ok": False, "error": "刷新远端失败：" + fetch_out[-400:],
                "commits": [], "files": [], "head": "",
            }
    head_code, head = _git(server_dir, "rev-parse", f"origin/{branch}",
                           git_creds=git_creds, ref=ref)
    if head_code != 0:
        return {"ok": False, "error": head[:200], "commits": [], "files": [], "head": ""}
    code, out = _git(server_dir, "log", "--no-merges", f"--max-count={max(1, int(limit))}",
                     "--pretty=%h\t%s", f"origin/{target}..origin/{branch}",
                     git_creds=git_creds, ref=ref)
    if code != 0:
        return {"ok": False, "error": out[:200], "commits": [], "files": [], "head": head.strip()}
    commits = []
    for ln in out.splitlines():
        sha, _, subject = ln.partition("\t")
        if sha.strip():
            commits.append({"sha": sha.strip(), "subject": subject.strip()[:200]})
    # Use a three-dot diff to show only the branch's changes for review.
    code2, out2 = _git(server_dir, "diff", "--no-ext-diff", "--name-only",
                       f"origin/{target}...origin/{branch}",
                       git_creds=git_creds, ref=ref)
    files = [x.strip() for x in out2.splitlines() if x.strip()][:40] if code2 == 0 else []
    return {
        "ok": True,
        "commits": commits,
        "files": files,
        "head": head.strip(),
        # This is deliberately computed from the freshly fetched remote refs.
        # A conflict repair may already be present on the task branch while a
        # later retry reports the same immutable head.  The workflow must be
        # able to distinguish that state from an agent that merely narrated a
        # repair without changing or synchronising its branch.
        "containsTarget": branch_contains_target(
            server_dir, branch, target, False, git_creds, ref),
    }


def branch_merged(server_dir: str, branch: str, target: str,
                  fetch: bool = False, git_creds: dict | None = None, ref: str = "") -> bool:
    """Determine whether the target branch already contains this branch by checking ancestry,
    regardless of who merged it. A branch can have zero commits ahead because conflict
    resolution already completed the merge; lack of remaining commits alone must not be treated
    as a failed delivery."""
    if not (_SAFE_BRANCH.match(branch or "") and _SAFE_BRANCH.match(target or "")):
        return False
    if fetch:
        _git(server_dir, "fetch", "--prune", "origin", git_creds=git_creds, ref=ref)
    code, _out = _git(server_dir, "merge-base", "--is-ancestor",
                      f"origin/{branch}", f"origin/{target}", git_creds=git_creds, ref=ref)
    return code == 0


def branch_contains_target(server_dir: str, branch: str, target: str,
                           fetch: bool = False, git_creds: dict | None = None,
                           ref: str = "") -> bool:
    """Return whether the remote task branch contains the current target head.

    This is the reverse of :func:`branch_merged`: ``branch_merged`` proves the
    candidate is already present in the protected target, while this helper
    proves the protected target has been merged/rebased into the candidate.
    The latter is the repository-backed proof that a merge-conflict repair is
    ready for deterministic merge retry.
    """
    if not (_SAFE_BRANCH.match(branch or "") and _SAFE_BRANCH.match(target or "")):
        return False
    if fetch:
        code, _out = _git(
            server_dir, "fetch", "--prune", "origin",
            git_creds=git_creds, ref=ref)
        if code != 0:
            return False
    code, _out = _git(
        server_dir, "merge-base", "--is-ancestor",
        f"origin/{target}", f"origin/{branch}",
        git_creds=git_creds, ref=ref)
    return code == 0


def merge_to(server_dir: str, branch: str, target: str,
             git_creds: dict | None = None, ref: str = "") -> dict:
    """Merge the branch into a freshly reset remote target and push it, returning command evidence
    and the resulting commit. Abort failed merges so no partial merge remains in the mirror.
    """
    steps: list[tuple[str, str]] = []

    def run(*args: str) -> tuple[int, str]:
        c, o = _git(server_dir, *args, git_creds=git_creds, ref=ref)
        steps.append(("git " + " ".join(args), o[:800]))
        return c, o

    if not os.path.isdir(os.path.join(server_dir, ".git")):
        return {"ok": False, "error": f"{server_dir} 不是一个 git 仓库", "steps": steps}
    if not (_SAFE_BRANCH.match(branch or "") and _SAFE_BRANCH.match(target or "")):
        return {"ok": False, "error": "分支名不合法", "steps": steps}

    c, o = run("fetch", "--prune", "origin")
    if c != 0:
        return {"ok": False, "error": "拉取远端失败：" + o[:200], "steps": steps}
    # Require the target branch to exist remotely; do not create an inferred target.
    c, o = run("rev-parse", "--verify", f"origin/{target}")
    if c != 0:
        return {"ok": False, "error": f"远端没有 {target} 分支", "steps": steps}
    c, o = run("checkout", "-B", target, f"origin/{target}")
    if c != 0:
        return {"ok": False, "error": "切到目标分支失败：" + o[:200], "steps": steps}
    c, o = run("merge", "--no-ff", f"origin/{branch}", "-m", f"自动合并 {branch} → {target}（SoduWork）")
    if c != 0:
        run("merge", "--abort")           # Abort a failed merge and restore a clean state.
        # Distinguish conflicts from identity, hook, and other Git failures.
        conflict = "CONFLICT" in o or "Automatic merge failed" in o
        # Return explanatory errors separately from raw Git output.
        # The frontend can then display diagnostics without mixing them into the user-facing summary.
        return {"ok": False,
                "error": "合并有冲突，已回退，等人处理完再合" if conflict else "合并失败，已回退",
                "output": o[:400], "conflict": conflict, "steps": steps}
    c, o = run("push", "origin", target)
    if c != 0:
        return {"ok": False, "error": "推送失败：" + o[:200], "steps": steps}
    c, sha = _git(server_dir, "rev-parse", "--short", "HEAD")
    return {"ok": True, "steps": steps, "commit": sha.strip() if c == 0 else "", "branch": branch,
            "target": target}
