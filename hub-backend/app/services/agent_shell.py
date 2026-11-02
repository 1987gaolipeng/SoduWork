"""Expose the host's bundled shell through each CLI's documented setting."""
from pathlib import Path


def apply(env: dict, key: str) -> None:
    variable = {"kimi": "KIMI_SHELL_PATH", "claude": "CLAUDE_CODE_GIT_BASH_PATH"}.get(key)
    if not variable:
        return
    configured = str(env.get(variable) or "")
    if configured and Path(configured).is_absolute() and Path(configured).is_file():
        return
    env.pop(variable, None)
    root = str(env.get("SODUWORK_BUNDLED_SHELL") or "")
    if root:
        shell = Path(root) / "bin" / "bash.exe"
        if shell.is_file():
            env[variable] = str(shell.resolve())
