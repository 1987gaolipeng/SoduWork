'''Truthful local login-state probes for account-owned agent CLIs.'''
from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable


ProbeRunner = Callable[[str, list[str]], tuple[int, str] | None]


def _run(executable: str, args: list[str], *, env: dict | None = None) -> tuple[int, str] | None:
    '''Run a bounded, local-only account status command.'''
    if not executable:
        return None
    try:
        env = dict(os.environ if env is None else env)
        env.pop('NODE_OPTIONS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
        proc = subprocess.run(
            [executable, *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            env=env,
            timeout=6,
            creationflags=flags,
            check=False,
        )
        return int(proc.returncode), str(proc.stdout or proc.stderr or '')[:400_000]
    except (OSError, subprocess.TimeoutExpired):
        return None


def probe(
    key: str,
    executable: str,
    *,
    runner: ProbeRunner | None = None,
    env: dict | None = None,
) -> tuple[str, str]:
    '''Prefer each CLI local status command; return empty for legacy fallback.'''
    key = str(key or '')
    run = runner or (lambda executable, args: _run(executable, args, env=env))
    args = (
        ['auth', 'status', '--json']
        if key == 'claude'
        else ['login', 'status']
        if key == 'codex'
        else []
    )
    result = run(executable, args) if args else None
    if result is None:
        return '', ''

    code, output = result
    lowered = output.lower()
    if key == 'claude':
        try:
            state = json.loads(output)
        except (ValueError, TypeError):
            state = {}
        if state.get('loggedIn') is True:
            return 'authed', '已用自己的 Anthropic 账号登录'
        if state.get('loggedIn') is False or 'not logged in' in lowered:
            return 'unauthed', '还没登录：在这台机器上运行 claude auth login'

    if key == 'codex':
        if code == 0 and 'logged in' in lowered and 'not logged in' not in lowered:
            return 'authed', '已用自己的 OpenAI/ChatGPT 账号登录'
        if 'not logged in' in lowered or 'login required' in lowered:
            return 'unauthed', '还没登录：在这台机器上运行 codex login'

    return '', ''


__all__ = ['probe']
