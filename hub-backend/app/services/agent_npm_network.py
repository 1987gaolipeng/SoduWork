"""Bounded npm recovery; custom registries and TLS policy remain authoritative."""
from __future__ import annotations

import os
import re
import subprocess
from urllib.parse import urlsplit

_NETWORK_CODES = {
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
    "ENETUNREACH", "EHOSTUNREACH", "FETCH_ERROR", "ERR_SOCKET_TIMEOUT",
    "E500", "E502", "E503", "E504",
}
_PUBLIC_ALTERNATIVES = {
    "registry.npmjs.org": "https://registry.npmmirror.com",
    "registry.npmmirror.com": "https://registry.npmjs.org",
}


def _alternative(npm: list[str], env: dict) -> str:
    if any(value and (key.upper() in {"NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_CONFIG_KEY", "NPM_CONFIG_CERT"}
                     or re.search(r"(?:auth|password|username|keyfile|certfile)", key, re.I))
           for key, value in env.items() if key.upper().startswith(("NPM_", "NODE_AUTH_"))):
        return ""
    try:
        # Read effective npmrc configuration without logging credentials or
        # changing it. A private or authenticated registry never falls back.
        result = subprocess.run(
            [*npm, "config", "get", "registry"], env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace", timeout=12,
            **({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
               if os.name == "nt" else {}))
        if result.returncode != 0:
            return ""
        registry = urlsplit(result.stdout.strip())
        if (registry.scheme != "https" or registry.username is not None
                or registry.password is not None or registry.port not in (None, 443)
                or registry.path not in ("", "/") or registry.query or registry.fragment):
            return ""
        configuration = subprocess.run(
            [*npm, "config", "list"], env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace", timeout=12,
            **({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if os.name == "nt" else {}))
        if configuration.returncode != 0:
            return ""
        # `list --json` omits protected keys. Plain `list` preserves their
        # names with (protected) values; inspect names only, never log output.
        for line in configuration.stdout.splitlines():
            key, separator, _value = line.strip().partition("=")
            key = key.strip().lower()
            if not separator or key.startswith((";", "#")):
                continue
            leaf = key.rsplit(":", 1)[-1].lstrip("_")
            if ((key.startswith("@") and key.endswith(":registry")) or
                    leaf in {"auth", "authtoken", "password", "username", "key", "cert", "keyfile", "certfile"}):
                return ""
        return _PUBLIC_ALTERNATIVES.get(registry.hostname, "")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return ""


def run(npm: list[str], args: list[str], *, env: dict, execute, say, **kwargs) -> tuple[int, str]:
    code, output = execute([*npm, *args], env=env, **kwargs)
    if code == 0 or not args or args[0] not in {"install", "view", "pack"}:
        return code, output
    codes = set(re.findall(r"npm\s+(?:ERR!|error)\s+code\s+([A-Z_0-9]+)", output))
    if not codes or not codes.issubset(_NETWORK_CODES):
        return code, output
    alternative = _alternative(npm, env)
    if not alternative:
        say("npm 下载未完成；请检查当前包源和代理后重试，已保留自定义源配置。")
        return code, output
    say("当前公开 npm 源连接失败，正在使用备用公开源重试一次：" + alternative)
    return execute([*npm, *args, "--registry=" + alternative], env=env, **kwargs)
