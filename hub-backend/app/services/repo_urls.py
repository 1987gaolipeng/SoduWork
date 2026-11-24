"""Validation helpers for repository remotes accepted by execution workers."""
from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit


_SCP_REMOTE = re.compile(r"^[^@\s/:]+@[^\s/:]+:[^\s]+$")
_HTTP_SCHEMES = {"http", "https", "ssh", "git"}


def validate_git_url(value) -> str:
    """Return a normalized remote URL or raise ``ValueError`` for local/script URLs."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("gitUrl 必须是字符串")
    remote = value.strip()
    if not remote:
        return ""
    if _SCP_REMOTE.fullmatch(remote):
        if len(remote) > 512:
            raise ValueError("gitUrl 长度不能超过 512 个字符")
        return remote
    parsed = urlsplit(remote)
    scheme = parsed.scheme.lower()
    if scheme not in _HTTP_SCHEMES or not parsed.netloc:
        raise ValueError("gitUrl 只允许 http(s)、ssh 或 git 远程地址")
    if parsed.password or (parsed.username and not (scheme == "ssh" and parsed.username == "git")):
        raise ValueError("gitUrl 不允许携带账号或密码")
    if any(char.isspace() for char in remote):
        raise ValueError("gitUrl 不能包含空白字符")
    if len(remote) > 512:
        raise ValueError("gitUrl 长度不能超过 512 个字符")
    return remote


def git_probe_url(value: str) -> str:
    """Return a credential-free remote for device selection, including legacy stored URLs."""
    remote = (value or "").strip()
    if not remote or len(remote) > 512 or any(ord(c) < 32 or c.isspace() for c in remote) or "\\" in remote:
        return ""
    # SCP-form SSH uses a login name for routing, not HTTP userinfo.
    if _SCP_REMOTE.fullmatch(remote):
        if "?" in remote or "#" in remote or remote.startswith("-"):
            return ""
        return remote
    try:
        parts = urlsplit(remote)
        if parts.scheme not in _HTTP_SCHEMES or not parts.hostname:
            return ""
        host = parts.hostname
        if any(c in host for c in "%@/"):
            return ""
        if ":" in host:
            host = f"[{host}]"
        if parts.port is not None:
            host += f":{parts.port}"
        if parts.scheme == "ssh" and parts.username == "git":
            host = "git@" + host
        # Query strings and fragments of historical remotes may also contain credentials.
        return validate_git_url(urlunsplit((parts.scheme, host, parts.path, "", "")))
    except ValueError:
        return ""
