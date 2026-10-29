"""Public module behavior and service contracts."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import subprocess

log = logging.getLogger("uvicorn.error")

_WIN = os.name == "nt"
_TIMEOUT = 40

# Secret fields must never be returned in plaintext.
SECRETS = ("token", "key", "gerrit_token")



CORE_FIELDS = ("name", "email", "user", "token", "key")
FIELDS = (*CORE_FIELDS, "gerrit_user", "gerrit_token")


def _store_dir() -> str:
    """Store SSH keys under LOCALAPPDATA to avoid home-directory rename restrictions and
    transparent encryption of private-key files.
    """
    from .local_base import _data_root
    d = os.path.join(_data_root(), "git-keys")
    os.makedirs(d, exist_ok=True)
    return d


# Credential persistence and retrieval.
def api_view(client) -> dict:
    """Return masked credential status, including presence, length, and type only."""
    g = dict(getattr(client, "git_creds", None) or {})
    tok = str(g.get("token") or "")
    key = str(g.get("key") or "")
    gerrit_tok = str(g.get("gerrit_token") or "")
    return {
        "name": str(g.get("name") or ""),
        "email": str(g.get("email") or ""),
        "user": str(g.get("user") or ""),
        "tokenSet": bool(tok), "tokenLen": len(tok),
        "keySet": bool(key), "keyType": _key_type(key), "keyFp": _key_fp(key),
        # Gerrit uses its own HTTP credentials, distinct from GitLab tokens.
        # Repository synchronization, refs/for pushes, and review votes use that independently configured account.
        "gerritUser": str(g.get("gerrit_user") or ""),
        "gerritTokenSet": bool(gerrit_tok), "gerritTokenLen": len(gerrit_tok),
        **_readiness(g),
    }


def _key_type(key: str) -> str:
    m = re.search(r"BEGIN (?:(RSA|DSA|EC|OPENSSH) )?PRIVATE KEY", key or "")
    if not m:
        return ""
    return (m.group(1) or "PKCS8").upper()


def _key_fp(key: str) -> str:
    """Return a short content digest for recognizing a pasted key. This is not an SSH public-key
    fingerprint and must be labeled accordingly.
    """
    k = (key or "").strip()
    return hashlib.sha256(k.encode("utf-8")).hexdigest()[:12] if k else ""


def _readiness(g: dict) -> dict:
    """Report commit identity and authentication readiness separately; a configured name does not
    prove push access.
    """
    ident = bool(str(g.get("name") or "").strip() and str(g.get("email") or "").strip())
    has_tok = bool(str(g.get("token") or "").strip())
    has_key = bool(str(g.get("key") or "").strip())
    push_ready = has_tok or has_key
    why = []
    if not ident:
        why.append("还没填提交人姓名和邮箱——不填的话代码库里这行改动是谁做的就看不出来")
    if not push_ready:
        why.append("还没配推送凭据（GitLab 的令牌或 SSH 私钥，配一种就行）")
    return {
        "identityReady": ident,
        "pushReady": push_ready,
        "ready": ident and push_ready,
        # Avoid repeating the configured-state heading in the status description.
        "why": "；".join(why) or "这台 SoduWork 派出去的代码活，都会用这个身份提交、用这套凭据推。",
    }


def save(client, body: dict) -> str | None:
    """Save supplied fields only. Omitted token/key fields remain unchanged; explicit null deletes
    them. Return an error message or None on success.
    """
    cur = dict(getattr(client, "git_creds", None) or {})
    b = body or {}
    for f in ("name", "email", "user", "gerrit_user"):
        if f in b:
            cur[f] = str(b.get(f) or "").strip()[:120]
    email = cur.get("email") or ""
    if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return "邮箱格式不对（git 会把它原样写进每一条提交里）"
    for f in SECRETS:
        if f not in b:
            continue                       # Omitted fields remain unchanged.
        v = b.get(f)
        if v is None or str(v).strip() == "":
            cur.pop(f, None)               # Explicitly remove the secret.
            continue
        val = str(v).strip() if f in ("token", "gerrit_token") else str(v)
        if f == "key":
            val = _normalize_key(val)
            if not _key_type(val):
                # Use plain text because this message is displayed without Markdown rendering.
                return ("这不像一把私钥（认不出 BEGIN … PRIVATE KEY 那一行）。"
                        "要贴的是私钥全文，不是 .pub 公钥。")
            if "ENCRYPTED" in val[:400]:
                return ("这把私钥带口令。AI 是在没有终端的后台进程里跑的，输不了口令——"
                        "请改用不带口令的密钥（部署密钥最合适），或者改配 HTTPS 的 token。")
        cur[f] = val[:8000]
    client.git_creds = cur
    return None


def _normalize_key(k: str) -> str:
    """Ensure a private key ends with a newline so SSH can parse pasted content."""
    k = (k or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    return k + "\n" if k else ""


def resolve(client) -> dict:
    """Resolve plaintext credentials only when preparing execution."""
    g = dict(getattr(client, "git_creds", None) or {})
    if not g:
        return {}
    return {k: g.get(k, "") for k in CORE_FIELDS}


def probe_fingerprint(client) -> str:
    """Return a non-reversible identity for the exact credentials used by a probe."""
    g = dict(getattr(client, "git_creds", None) or {})
    material = "\0".join(
        f"{field}={str(g.get(field) or '')}" for field in FIELDS
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()




# Git subprocess environment.
def _helper_script() -> str:
    """Use this task owner's HTTPS account; credentials remain in the environment."""
    return ('!f(){ echo "username=$SODUWORK_GIT_USER"; '
            'echo "password=$SODUWORK_GIT_TOKEN"; }; f')


def env_for(env: dict, git: dict, *, ref: str = "") -> dict:
    """Inject resolved Git identity and credentials into env in place. Empty credentials preserve
    executor defaults.
    """
    if not git:
        return env
    name = str(git.get("name") or "").strip()
    email = str(git.get("email") or "").strip()
    token = str(git.get("token") or "").strip()
    key = str(git.get("key") or "")

    # Always disable terminal prompting to prevent unattended Git commands from waiting for input.
    env["GIT_TERMINAL_PROMPT"] = "0"

    pairs: list[tuple[str, str]] = []
    if name and email:
        pairs += [("user.name", name), ("user.email", email)]
        # Set author and committer environment variables to override repository-local identity settings.
        env["GIT_AUTHOR_NAME"] = env["GIT_COMMITTER_NAME"] = name
        env["GIT_AUTHOR_EMAIL"] = env["GIT_COMMITTER_EMAIL"] = email
    if token:
        env["SODUWORK_GIT_USER"] = str(git.get("user") or name or "git")
        env["SODUWORK_GIT_TOKEN"] = token
        # The empty credential.helper entry must precede the custom helper.
        # It clears inherited helpers such as Git Credential Manager.
        # Otherwise interactive credential handling can stall an unattended command.
        pairs += [("credential.helper", ""), ("credential.helper", _helper_script())]
    if key:
        # Name private-key files by a short content digest so identical keys share a stored file.
        # This avoids rewriting keys for every dispatch.
        path = _write_key(key, ref or _key_fp(key))
        if path:
            ssh = _ssh_bin()
            # IdentitiesOnly restricts SSH to this key instead of trying unrelated agent keys.
            # accept-new accepts first-seen host keys but rejects changed keys.
            env["GIT_SSH_COMMAND"] = (
                f'"{ssh}" -i "{path}" -o IdentitiesOnly=yes '
                f'-o StrictHostKeyChecking=accept-new -o BatchMode=yes')
    if pairs:
        # Build the execution's GIT_CONFIG_* entries from index zero.
        env["GIT_CONFIG_COUNT"] = str(len(pairs))
        for i, (k, v) in enumerate(pairs):
            env[f"GIT_CONFIG_KEY_{i}"] = k
            env[f"GIT_CONFIG_VALUE_{i}"] = v
    return env


def _ssh_bin() -> str:
    import shutil
    return (shutil.which("ssh") or ("C:\\Windows\\System32\\OpenSSH\\ssh.exe" if _WIN else "ssh"))


def _write_key(key: str, ref: str) -> str:
    """Write an SSH key file with access restricted to the current user. OpenSSH rejects overly
    permissive private-key files.
    """
    try:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(ref or "default"))[:60]
        path = os.path.join(_store_dir(), safe + ".key")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(_normalize_key(key))
        _lock_down(path)
        return path
    except Exception as e:  # noqa: BLE001
        log.warning("私钥落盘失败: %s", type(e).__name__)
        return ""


def _lock_down(path: str) -> None:
    if _WIN:
        user = os.environ.get("USERNAME") or ""
        # Remove inherited ACL entries before granting access to the current user.
        subprocess.run(["icacls", path, "/inheritance:r"], capture_output=True, timeout=20)
        if user:
            subprocess.run(["icacls", path, "/grant:r", f"{user}:R"],
                           capture_output=True, timeout=20)
    else:
        os.chmod(path, 0o600)


def forget_key(ref: str) -> None:
    """Remove an execution's private-key file during cleanup."""
    try:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(ref or "default"))[:60]
        p = os.path.join(_store_dir(), safe + ".key")
        if os.path.isfile(p):
            os.remove(p)
    except Exception:  # noqa: BLE001
        pass


# Credential verification.
def probe_sync(git: dict, url: str) -> dict:
    """Verify credentials with a real, read-only git ls-remote request, exercising authentication
    without modifying the remote repository.
    """
    url = (url or "").strip()
    if not url:
        return {"ok": False, "detail": "先给一个仓库地址（挑一个工程，或者自己贴一个）"}
    kind = "ssh" if (url.startswith("ssh://") or re.match(r"^[^/]+@[^/]+:", url)) else "https"
    # First check that the credential type matches the repository URL.
    if kind == "https" and not str(git.get("token") or "").strip():
        return {"ok": False, "kind": kind,
                "detail": "这是个 HTTPS 地址，但你还没配 token。要么配 token，要么换用 SSH 地址。"}
    if kind == "ssh" and not str(git.get("key") or "").strip():
        return {"ok": False, "kind": kind,
                "detail": "这是个 SSH 地址，但你还没配私钥。要么贴私钥，要么换用 HTTPS 地址。"}
    # Then perform the actual authentication check.
    env = dict(os.environ)
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(k, None)                 # Validate credentials by connecting directly to the repository service.
    env = env_for(env, git, ref="probe")
    try:
        p = subprocess.run(["git", "-c", "http.proxy=", "-c", "https.proxy=",
                            "ls-remote", "--heads", url],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=_TIMEOUT, env=env)
        out = ((p.stdout or "") + (p.stderr or "")).strip()
        if p.returncode == 0:
            n = len([ln for ln in (p.stdout or "").splitlines() if ln.strip()])
            who = str(git.get("name") or "") + " <" + str(git.get("email") or "") + ">"
            return {"ok": True, "kind": kind,
                    "detail": f"通了 —— 读到 {n} 个分支。提交时会署名 {who}"
                              if str(git.get("name") or "") else f"通了 —— 读到 {n} 个分支"}
        return {"ok": False, "kind": kind, "detail": _why_failed(out, kind)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "kind": kind,
                "detail": f"超过 {_TIMEOUT} 秒没反应——多半是连不上那台服务器（内网地址？要不要挂代理？）"}
    except FileNotFoundError:
        return {"ok": False, "kind": kind, "detail": "这台执行机上没有 git"}
    finally:
        forget_key("probe")


# Translate recognized failures into actionable messages rather than returning only an exit code.
_HINTS = [
    ("could not read username", "没拿到用户名/密码——token 没配上，或者被这台机器的凭据管理器截胡了"),
    ("authentication failed", "账号或 token 不对（GitLab 上常见的是要用 access token 而不是登录密码）"),
    ("invalid username or password", "账号或 token 不对"),
    ("unprotected private key", "私钥文件权限太松，ssh 拒绝用它——SoduWork 会自动收紧，"
                                "还报这个说明这台机器的权限设置拦住了"),
    ("permission denied (publickey", "远端不认这把私钥——对应的公钥加到账号上了吗？"),
    ("enter passphrase", "这把私钥带口令，后台进程输不了——请换一把不带口令的"),
    ("bad passphrase", "这把私钥带口令，后台进程输不了——请换一把不带口令的"),
    ("host key verification failed", "主机指纹对不上（服务器换过钥匙？）"),
    ("repository not found", "地址不对，或者这个账号看不到这个仓库"),
    ("access denied", "这个账号没有这个仓库的权限"),
    ("403", "这个账号没有这个仓库的权限"),
    ("404", "地址不对，或者这个账号看不到这个仓库"),
    ("could not resolve host", "这个地址解析不了（内网域名？这台执行机连得到吗）"),
    ("connection refused", "连不上那台服务器（端口不通）"),
    ("connection timed out", "连那台服务器超时"),
    ("ssl certificate problem", "证书校验没过（自签证书的内网服务器常见）"),
]


def _why_failed(out: str, kind: str) -> str:
    low = (out or "").lower()
    for k, msg in _HINTS:
        if k in low:
            return msg
    tail = " ".join([ln for ln in (out or "").splitlines() if ln.strip()][-2:])[:200]
    return tail or "没通，但 git 什么也没说"
