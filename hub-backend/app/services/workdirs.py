"""Public module behavior and service contracts."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import subprocess
import time
import uuid

log = logging.getLogger("uvicorn.error")

_TIMEOUT = 600          # Allow sufficient time to clone large repositories.
TEMP_DIR_NAME = "temp"


def _safe_seg(s: str) -> str:
    """Sanitize one directory-name component by removing separators and Windows-invalid characters.

    """
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(s or "")).strip(" .")[:80] or "x"


def work_root_of(client, fallback: str = "") -> str:
    """Prefer the device's current reported work root, otherwise the persisted value used by
    unattended dispatch.
    """
    return (str(fallback or "").strip()
            or str(getattr(client, "work_root", "") or "").strip())


def temp_dir(root: str, task_id: str) -> str:
    """Create a unique temporary workspace under root/temp for each task attempt. If root is unset,
    use the archive root rather than writing into the user's home directory.
    """
    if not root:
        from .local_base import _data_root
        parent = os.path.join(_data_root(), "workspaces")
    else:
        parent = os.path.join(root, TEMP_DIR_NAME)
    stem = "%s_%d" % (_safe_seg(task_id), int(time.time()))
    # Second-resolution timestamps can collide between rapid attempts.
    # Add a suffix until a fresh directory is created.
    # Use exist_ok=False to prevent silent reuse of previous outputs.
    for i in range(50):
        d = os.path.join(parent, stem if i == 0 else "%s-%d" % (stem, i + 1))
        try:
            os.makedirs(d)
            return d
        except FileExistsError:
            continue
    d = os.path.join(parent, "%s-%s" % (stem, uuid.uuid4().hex[:6]))
    os.makedirs(d, exist_ok=True)
    return d


def repo_dir(root: str, repo) -> str:
    """Resolve a repository beneath the work root using its relative directory or a sanitized name
    fallback.
    """
    if not root:
        return ""
    sub = str(getattr(repo, "local_dir", "") or "").strip()
    if not sub:
        sub = _safe_seg(getattr(repo, "name", "") or getattr(repo, "id", ""))
    # Allow relative subdirectories but reject traversal outside the root.
    sub = sub.replace("\\", "/").strip("/")
    if ".." in sub.split("/"):
        sub = _safe_seg(sub)
    return os.path.normpath(os.path.join(root, *sub.split("/")))


def _git(cwd: str | None, args: list[str], env: dict | None = None) -> tuple[int, str]:
    cmd = ["git", "-c", "http.proxy=", "-c", "https.proxy=", *args]
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=_TIMEOUT,
                           stdin=subprocess.DEVNULL)   # Do not inherit stdin for unattended subprocesses.
        return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()
    except subprocess.TimeoutExpired:
        return 124, "超时（>%ds）：git %s" % (_TIMEOUT, " ".join(args[:3]))
    except FileNotFoundError:
        return 127, "这台机器上没有 git"
    except Exception as e:  # noqa: BLE001
        return 1, "git 跑不起来（%s）" % type(e).__name__


def auto_dir(client, repo) -> tuple[str, str]:
    """Resolve unattended workspaces from the task owner's reported work root, with legacy
    repository ai_work_dir fallback when unavailable. Return the directory and explanation.
    """
    root = work_root_of(client)
    if root and repo is not None:
        d = repo_dir(root, repo)
        if d:
            return d, "用的是这台 SoduWork 设的工作目录"
    awd = (getattr(repo, "ai_work_dir", "") or "").strip() if repo is not None else ""
    if awd:
        return awd, "这台 SoduWork 还没报过工作目录，回落到工程配的 AI 干活目录"
    return "", "既没有 SoduWork 的工作目录，工程也没配 AI 干活目录"


def plan(work_root: str, repo, task_id: str, device_path: str = "",
         git_creds: dict | None = None, *, execution_key: str = "",
         base_ref: str = "") -> dict:
    """Shared workspace-planning entry point returning ok, dir, cloned, and detail. Use isolated
    temporary directories for non-project tasks and prepare the selected repository path for
    project work.
    """
    if repo is None:
        return {"ok": True, "dir": temp_dir(work_root, task_id), "cloned": False,
                "detail": "临时活，单开一个工作目录"}
    target = (device_path or "").strip() or repo_dir(work_root, repo)
    prepared = ensure_repo(target, repo, git_creds)
    if not prepared.get("ok") or not str(execution_key or "").strip():
        return prepared
    return isolated_repo(
        target, work_root, repo, str(execution_key), str(base_ref or ""), git_creds)


_SAFE_BASE_REF = re.compile(r"^[A-Za-z0-9._/\-]{1,160}$")


def isolated_repo(primary: str, work_root: str, repo, execution_key: str,
                  base_ref: str = "", git_creds: dict | None = None) -> dict:
    """Create one detached Git worktree for one workflow-node attempt.

    The primary clone remains the user's visible cache. AI nodes never share its mutable
    checkout, so a disobedient scope/review agent cannot poison the next workflow stage.
    """
    if not primary or not os.path.isdir(os.path.join(primary, ".git")):
        return {"ok": False, "dir": "", "cloned": False, "isolated": False,
                "detail": "工程主克隆还没有准备好，无法创建隔离工作区"}
    ref = (base_ref or str(getattr(repo, "default_branch", "") or "")).strip()
    if not ref or not _SAFE_BASE_REF.fullmatch(ref) or ".." in ref.split("/"):
        return {"ok": False, "dir": "", "cloned": False, "isolated": False,
                "detail": "隔离工作区的基线分支或提交不合法"}
    target_ref = ref if re.fullmatch(r"[0-9a-fA-F]{7,64}", ref) else "origin/" + ref
    env = _repo_env(repo, git_creds)
    code, head = _git(primary, ["rev-parse", "--verify", target_ref + "^{commit}"], env)
    if code:
        return {"ok": False, "dir": "", "cloned": False, "isolated": False,
                "detail": "找不到本轮隔离工作区的固定基线：" + (head[-200:] or ref)}
    head = head.splitlines()[0].strip()
    root = os.path.abspath((work_root or os.path.dirname(primary) or primary).strip())
    repo_name = _safe_seg(
        getattr(repo, "local_dir", "") or getattr(repo, "name", "")
        or getattr(repo, "id", "") or "repository")[:48]
    digest = hashlib.sha256(execution_key.encode("utf-8")).hexdigest()[:20]
    target = os.path.join(root, ".soduwork", "worktrees", repo_name, digest)
    if os.path.isdir(target):
        inside_code, inside = _git(target, ["rev-parse", "--is-inside-work-tree"], env)
        head_code, existing_head = _git(target, ["rev-parse", "HEAD"], env)
        if inside_code == 0 and inside.strip() == "true" and head_code == 0:
            if existing_head.strip() != head:
                return {"ok": False, "dir": target, "cloned": False, "isolated": True,
                        "detail": "本轮隔离工作区已存在，但基线版本不一致"}
            return {"ok": True, "dir": target, "cloned": False, "isolated": True,
                    "baseHead": head, "cacheDir": primary, "detail": "复用本轮隔离工作区"}
        if os.listdir(target):
            return {"ok": False, "dir": target, "cloned": False, "isolated": True,
                    "detail": "隔离工作区路径已被其他文件占用"}
    os.makedirs(os.path.dirname(target), exist_ok=True)
    _git(primary, ["worktree", "prune"], env)
    code, out = _git(primary, ["worktree", "add", "--detach", target, target_ref], env)
    if code:
        return {"ok": False, "dir": target, "cloned": False, "isolated": True,
                "detail": "创建隔离工作区失败：" + (out[-240:] or "git 没有说明原因")}
    return {"ok": True, "dir": target, "cloned": False, "isolated": True,
            "baseHead": head, "cacheDir": primary, "detail": "已创建本轮专属隔离工作区"}


def _repo_env(repo, git_creds: dict | None = None) -> dict:
    url = str(getattr(repo, "git_url", "") or "").strip()
    env = dict(os.environ)
    from .local_base import _git_host_no_proxy
    _git_host_no_proxy(env, url)
    if git_creds:
        from .code_creds import env_for
        env_for(env, git_creds)
    else:
        env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def ensure_repo(d: str, repo, git_creds: dict | None = None) -> dict:
    """Clone a repository on first use and fetch thereafter with the task owner's credentials.
    Return actionable failures instead of starting AI in an unprepared empty directory.
    """
    if not d:
        return {"ok": False, "dir": "", "cloned": False,
                "detail": "这台 SoduWork 还没设工作目录（桌宠 → 设置 → 工作目录）"}
    url = str(getattr(repo, "git_url", "") or "").strip()
    env = _repo_env(repo, git_creds)
    # Add repository hosts to NO_PROXY while preserving other services' existing proxy settings.
    # _repo_env already disables interactive prompts, even without credentials; fail immediately on missing permission.

    if os.path.isdir(os.path.join(d, ".git")):
        # Fetch updates in existing repositories without modifying worktree files.
        code, out = _git(d, ["fetch", "--all", "--prune"], env)
        if code != 0:
            log.info("工程 %s fetch 没成功（不拦着往下干）：%s", d, out[:200])
        return {"ok": True, "dir": d, "cloned": False,
                "detail": "工程已经在了" + ("" if code == 0 else "（fetch 没成功，用的是本地这份）")}

    if os.path.isdir(d) and os.listdir(d):
        # Reject an existing non-Git directory rather than cloning over user contents.
        return {"ok": False, "dir": d, "cloned": False,
                "detail": "目录 %s 已经有东西了，但它不是个 git 仓库。"
                          "换个工程子目录，或者先把它清干净。" % d}
    if not url:
        return {"ok": False, "dir": d, "cloned": False,
                "detail": "这个工程没配 git 地址，没法第一次自动拉取（管理端 → 工程里补上）"}

    os.makedirs(os.path.dirname(d) or d, exist_ok=True)
    branch = str(getattr(repo, "default_branch", "") or "").strip()
    args = ["clone", url, d]
    if branch:
        args = ["clone", "--branch", branch, url, d]
    log.info("第一次用这个工程，先 clone 到 %s", d)
    code, out = _git(None, args, env)
    if code != 0:
        return {"ok": False, "dir": d, "cloned": False, "detail": _why_clone_failed(out)}
    return {"ok": True, "dir": d, "cloned": True, "detail": "第一次用这个工程，已经拉下来了"}


_CLONE_HINTS = [
    ("could not read username", "私有仓库要凭据——去桌宠「更多 → 代码账号」配一个再派"),
    ("authentication failed", "代码账号或令牌不对（去「代码账号」页点「测一下」确认）"),
    ("permission denied (publickey", "远端不认这把私钥（公钥加到账号上了吗）"),
    ("repository not found", "仓库地址不对，或者这个账号看不到它"),
    ("could not resolve host", "仓库地址解析不了（内网域名？这台机器连得到吗）"),
    ("already exists and is not an empty directory", "目标目录已经有东西了"),
    ("remote branch", "工程配的默认分支在远端不存在"),
]


def _why_clone_failed(out: str) -> str:
    low = (out or "").lower()
    for k, msg in _CLONE_HINTS:
        if k in low:
            return "第一次拉代码没成功：" + msg
    tail = " ".join([x for x in (out or "").splitlines() if x.strip()][-2:])[:200]
    return "第一次拉代码没成功：" + (tail or "git 什么也没说")


# Artifact validation.
# Office document containers use ZIP structure with a PK signature.
_ZIPPY = {".docx", ".xlsx", ".pptx", ".zip", ".jar"}


def check_artifact(path: str) -> str:
    """Behavior and constraints for this operation."""
    ext = os.path.splitext(path or "")[1].lower()
    if ext not in _ZIPPY:
        return ""
    try:
        with open(path, "rb") as f:
            head = f.read(2)
    except Exception as e:  # noqa: BLE001
        return "读不出来（%s）" % type(e).__name__
    if head == b"PK":
        return ""
    return ("这个文件不是有效的 %s（开头不是 zip 标志，读到的是 %r）。"
            "多半是被这台机器的透明加密动过——换个工作目录（比如 %%LOCALAPPDATA%% 下）再试。"
            % (ext.lstrip("."), head))
