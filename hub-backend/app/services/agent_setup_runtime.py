"""Bounded executable probes and official Codex dependency verification."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess

from .local_base import _WIN, _bundled_pi_node, _npm_root
from . import agent_npm_runtime


def _kill_probe_tree(proc: subprocess.Popen) -> None:
    """Stop a timed-out version probe including descendants holding its pipes."""
    if proc.poll() is not None:
        return
    if _WIN:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False)
            return
        except Exception:  # noqa: BLE001
            pass
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            return
        except Exception:  # noqa: BLE001
            pass
    try:
        proc.kill()
    except Exception:  # noqa: BLE001
        pass


def _short(exe: str | None, args: list[str], timeout: int = 12) -> str:
    """Run a bounded one-line probe; a broken CLI must not stall the Runner."""
    if not exe:
        return ""
    proc = None
    try:
        env = dict(os.environ)
        # Electron starts the embedded Runner. Never leak its Node bootstrap flags
        # into ordinary CLIs; only bundled Pi deliberately uses Electron as Node.
        env.pop("NODE_OPTIONS", None)
        env.pop("ELECTRON_RUN_AS_NODE", None)
        bundled_node = _bundled_pi_node()
        if (bundled_node and os.path.normcase(os.path.abspath(exe)) ==
                os.path.normcase(os.path.abspath(bundled_node))):
            env["ELECTRON_RUN_AS_NODE"] = "1"
        options = {}
        if _WIN:
            options["creationflags"] = (getattr(subprocess, "CREATE_NO_WINDOW", 0) |
                                        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        else:
            options["start_new_session"] = True
        proc = subprocess.Popen(
            [exe, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            env=env, **options)
        try:
            out, err = proc.communicate(timeout=max(1, int(timeout)))
        except subprocess.TimeoutExpired:
            _kill_probe_tree(proc)
            try:
                proc.communicate(timeout=2)
            except Exception:  # noqa: BLE001
                for pipe in (proc.stdout, proc.stderr):
                    if pipe is not None:
                        pipe.close()
            return ""
        if proc.returncode != 0:
            return ""
        # Native CLIs may warn on stderr before printing a valid stdout version.
        # Prefer the result stream, retaining stderr-only version compatibility.
        text = (out or "").strip() or (err or "").strip()
        return text.splitlines()[0].strip()[:80] if text else ""
    except Exception:  # noqa: BLE001
        if proc is not None:
            _kill_probe_tree(proc)
        return ""


def _codex_native_name() -> str:
    """Official platform package used by the Codex App Server binary."""
    system, arch = agent_npm_runtime.runtime_target()
    system = system if system in {"win32", "linux", "darwin"} else ""
    return f"@openai/codex-{system}-{arch}" if system and arch else ""


def _codex_package_dir() -> str:
    """Locate the adapter's resolved Codex package, before a personal copy."""
    candidates = [path for root in agent_npm_runtime.package_roots(_npm_root()) for path in (
        # Prefer the adapter's private dependency when npm could not hoist it
        # beside an older, explicitly installed personal Codex package.
        os.path.join(root, "@agentclientprotocol", "codex-acp", "node_modules",
                     "@openai", "codex", "package.json"),
        os.path.join(root, "@openai", "codex", "package.json"),
    )]
    for package_file in candidates:
        if os.path.isfile(package_file):
            return str(Path(package_file).resolve().parent)
    return ""


def _codex_dependency_version() -> str:
    """Read the Codex version actually resolved by the installed ACP adapter."""
    directory = _codex_package_dir()
    if directory:
        try:
            return str(json.loads((Path(directory) / "package.json").read_text(
                encoding="utf-8")).get("version") or "").strip()
        except (OSError, ValueError, TypeError):
            pass
    return ""


def _codex_native_spec(version: str) -> str:
    name = _codex_native_name()
    if not (name and version):
        return ""
    target = name.removeprefix("@openai/codex-")
    return f"{name}@npm:@openai/codex@{version}-{target}"


def _codex_native_details() -> tuple[str, str]:
    """Follow Node's nearest-package resolution and verify the native payload."""
    directory = _codex_package_dir()
    native = _codex_native_name()
    if not (directory and native):
        return "", ""
    target = native.removeprefix("@openai/codex-")
    system, arch = target.split("-", 1)
    triple = ("x86_64" if arch == "x64" else "aarch64") + {
        "win32": "-pc-windows-msvc", "linux": "-unknown-linux-musl", "darwin": "-apple-darwin",
    }[system]
    executable = "codex.exe" if system == "win32" else "codex"
    start = Path(directory)
    # Node does not search node_modules/node_modules, nor skip a broken closer
    # package in favor of a healthy but unreachable global installation.
    for cursor in (start, *start.parents):
        if cursor.name == "node_modules":
            continue
        package = cursor.joinpath("node_modules", *native.split("/"))
        package_file = package / "package.json"
        if not package_file.is_file():
            continue
        try:
            binary = package / "vendor" / triple / "bin" / executable
            if not binary.is_file() or binary.stat().st_size == 0:
                return "", ""
            version = str(json.loads(package_file.read_text(encoding="utf-8")).get("version") or "").strip()
            return version, str(binary)
        except (OSError, ValueError, TypeError):
            return "", ""
    return "", ""


def _codex_native_version() -> str:
    return _codex_native_details()[0]


def _codex_native_binary() -> str:
    return _codex_native_details()[1]


def _codex_native_matches(codex_version: str, native_version: str) -> bool:
    return bool(codex_version and native_version
                and native_version.startswith(codex_version + "-"))


