"""Native Node/npm pairs and writable, Runner-owned Agent installations.

Discovery is read-only. Installation never changes the system npm configuration,
Node executable or permissions; its prefix/cache live beside the Runner data.
"""
from __future__ import annotations

import json
import functools
import os
import platform
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading

from .agent_version_probe import probe as cached_probe


NODE_MINIMUMS = {
    "pi": (22, 19, 0),
    "qwen": (22, 0, 0),
    "codex-harness": (20, 0, 0),
    "dsh": (22, 15, 0),
    "codex": (20, 0, 0),
    "kimi": (22, 19, 0),
    "claude": (22, 0, 0),
}
_INSTALL_LOCK = threading.Lock()
_NODE_IDENTITY = """(() => {
  const identity = {node:process.versions.node, electron:!!process.versions.electron,
                    platform:process.platform, arch:process.arch, libc:''};
  if (process.platform === 'linux') {
    try {
      process.report.excludeNetwork = true;
      const report = process.report.getReport();
      identity.libc = report.header.glibcVersionRuntime ? 'glibc' :
        (report.sharedObjects || []).some(p => /(?:libc\\.musl-|ld-musl-)/.test(p)) ? 'musl' : '';
    } catch (_) {}
  }
  return JSON.stringify(identity);
})()"""


def serial_install(fn):
    @functools.wraps(fn)
    def run(*args, **kwargs):
        # All managed npm Agents share one dependency tree. Concurrent global
        # installs can otherwise remove one another's platform dependencies.
        with _INSTALL_LOCK:
            return fn(*args, **kwargs)
    return run


def version_tuple(value: str) -> tuple[int, int, int]:
    match = re.search(r"(?:^|\s)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", str(value or ""))
    return tuple(int(match.group(i) or 0) for i in (1, 2, 3)) if match else (0, 0, 0)


def private_prefix(data_root: str = "") -> str:
    if not data_root:
        from .local_base import _data_root
        data_root = _data_root()
    return os.path.join(os.path.abspath(data_root), "agent-runtimes", "npm")


def private_root() -> str:
    prefix = private_prefix()
    if not prefix:
        return ""
    return os.path.join(prefix, *(('node_modules',) if sys.platform == 'win32' else ('lib', 'node_modules')))


def private_bin_dir(prefix: str = "") -> str:
    prefix = prefix or private_prefix()
    return (prefix if sys.platform == "win32" else os.path.join(prefix, "bin")) if prefix else ""


def package_roots(legacy_root: str = "") -> list[str]:
    return list(dict.fromkeys(p for p in (private_root(), legacy_root) if p))


def package_entry(package: str, command: str, legacy_root: str = "") -> str:
    for root in package_roots(legacy_root):
        directory = Path(root).joinpath(*package.split("/"))
        try:
            info = json.loads((directory / "package.json").read_text(encoding="utf-8"))
            bins = info.get("bin") or {}
            entry = bins.get(command) if isinstance(bins, dict) else bins
            target = (directory / str(entry or "")).resolve()
            if entry and target.is_relative_to(directory.resolve()) and target.is_file():
                return str(target)
        except (OSError, ValueError, TypeError):
            pass
    return ""


def package_engine(package: str, legacy_root: str = "") -> str:
    for root in package_roots(legacy_root):
        try:
            info = json.loads(Path(root).joinpath(*package.split("/"), "package.json").read_text(encoding="utf-8"))
            return str((info.get("engines") or {}).get("node") or "")
        except (OSError, ValueError, TypeError):
            continue
    return ""


def private_bin(names) -> str:
    directory = private_bin_dir()
    if directory:
        for name in names:
            # npm's Windows shim without an extension is a POSIX shell script.
            # Only select a Windows executable or npm's Windows launcher here.
            suffixes = (".exe", ".cmd") if sys.platform == "win32" and not os.path.splitext(name)[1] else ("",)
            for suffix in suffixes:
                candidate = os.path.join(directory, name + suffix)
                if os.path.isfile(candidate) and (sys.platform == "win32" or os.access(candidate, os.X_OK)):
                    return candidate
    return ""


def clean_env() -> dict:
    env = dict(os.environ)
    env.pop("NODE_OPTIONS", None)
    env.pop("NODE_PATH", None)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    return env


def _stamp(path: str):
    try:
        stat = os.stat(path)
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return 0, 0


def _run_probe(executable: str, args: list[str], timeout: int = 8) -> str:
    try:
        result = subprocess.run(
            [executable, *args], env=clean_env(), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
            text=True, encoding="utf-8", errors="replace",
            **({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
               if os.name == "nt" else {}))
        return result.stdout.strip()[:300] if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _probe(argv: tuple[str, ...], _stamps: tuple) -> str:
    return cached_probe(argv[0], list(argv[1:]), run=_run_probe, timeout=8)


def _npm_cli(node: str, path_value: str) -> str:
    base = Path(node).parent
    candidates = [base / "node_modules/npm/bin/npm-cli.js",
                  base.parent / "lib/node_modules/npm/bin/npm-cli.js",
                  base.parent / "share/nodejs/npm/bin/npm-cli.js"]
    for name in ("npm.cmd", "npm") if os.name == "nt" else ("npm",):
        npm = shutil.which(name, path=path_value)
        if npm:
            real = Path(os.path.realpath(npm))
            if real.name == "npm-cli.js":
                candidates.append(real)
            candidates.append(Path(npm).parent / "node_modules/npm/bin/npm-cli.js")
    return next((str(p) for p in candidates if p.is_file()), "")


def resolve() -> dict:
    """Find real Node, ignoring the Electron-backed desktop command shim.

    npm is always invoked as ``selected-node npm-cli.js``. A shebang or .cmd
    launcher must not silently select a different (possibly obsolete) Node.
    """
    path_value = os.environ.get("PATH", "")
    bundled = os.path.normcase(os.path.abspath(os.environ.get("SODUWORK_BUNDLED_NODE") or "."))
    candidates, seen = [], set()
    name = "node.exe" if os.name == "nt" else "node"
    for directory in path_value.split(os.pathsep):
        if not directory:
            continue
        node = os.path.abspath(os.path.join(directory.strip('"'), name))
        identity = os.path.normcase(os.path.realpath(node))
        if identity in seen or identity == bundled or not os.path.isfile(node):
            continue
        seen.add(identity)
        # The POSIX shim is a script named node, not a native executable.
        try:
            with open(node, "rb") as stream:
                if stream.read(2) == b"#!":
                    continue
        except OSError:
            continue
        raw = _probe((node, "-p", _NODE_IDENTITY),
                     (_stamp(node),))
        try:
            info = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(info, dict) or info.get("electron") or not info.get("node"):
            continue
        npm = _npm_cli(node, path_value)
        npm_version = _probe((node, npm, "--version"), (_stamp(node), _stamp(npm))) if npm else ""
        pair = {"nodePath": node, "node": "v" + str(info["node"]),
                "npmPath": npm, "npm": npm_version,
                "platform": str(info.get("platform") or ""), "arch": str(info.get("arch") or ""),
                "libc": str(info.get("libc") or "")}
        candidates.append(pair)
        if npm_version and version_tuple(pair["node"]) >= (22, 19, 0):
            return pair
    # Preserve PATH precedence among suitable native pairs; a later modern
    # installation can rescue an obsolete Node at the front of PATH.
    return next(iter([p for p in candidates if p["npm"]] or candidates), {})


def runtime_target(pair: dict | None = None) -> tuple[str, str]:
    """Native npm dependencies must match Node, including Rosetta installations."""
    pair = resolve() if pair is None else pair
    system, arch = str(pair.get("platform") or ""), str(pair.get("arch") or "")
    if system == sys.platform and arch in {"x64", "arm64"}:
        return system, arch
    machine = platform.machine().lower()
    arch = "x64" if machine in {"amd64", "x86_64", "x64"} else "arm64" if machine in {"arm64", "aarch64"} else ""
    return sys.platform, arch


def configured_global_root() -> str:
    """Ask the installer's npm for its tree, including user/global npmrc prefixes."""
    pair = resolve()
    node, npm = pair.get("nodePath"), pair.get("npmPath")
    if not node or not npm:
        return ""
    # Reuse bounded, short-lived probes; npmrc edits must invalidate the cache.
    config_files = [str(Path.home() / ".npmrc"),
                    str(Path(node).parent / "etc/npmrc"),
                    str(Path(npm).parent.parent / "npmrc")]
    for key, value in os.environ.items():
        if key.lower() in ("npm_config_userconfig", "npm_config_globalconfig") and value:
            config_files.append(value)
    root = cached_probe(node, [npm, "root", "--global"], run=_run_probe,
                        files=config_files, timeout=8)
    if not root or "\n" in root or "\r" in root or not os.path.isabs(root):
        return ""
    return os.path.normpath(root)


def environment(pair: dict, *, install: bool = False) -> dict:
    env = clean_env()
    node = str(pair.get("nodePath") or "")
    prefix = private_prefix()
    paths = ([os.path.dirname(node)] if node else [])
    if prefix:
        paths.append(private_bin_dir(prefix))
    elif os.name == "nt":
        from .local_base import _npm_root
        # npm installs .cmd launchers beside node_modules. A custom prefix (or
        # a desktop launched before PATH refresh) must still be usable at once.
        paths.append(os.path.dirname(_npm_root()))
    env["PATH"] = os.pathsep.join(dict.fromkeys(paths + env.get("PATH", "").split(os.pathsep)))
    if install and prefix:
        # A developer's cross-compilation settings must not select a foreign
        # native package for an installation on this execution machine.
        for key in list(env):
            if key.lower() in {"npm_config_arch", "npm_config_cpu", "npm_config_platform",
                               "npm_config_os", "npm_config_libc", "npm_config_target_arch",
                               "npm_config_target_platform"}:
                env.pop(key)
        # Explicit per-command config overrides inherited read-only/global
        # prefixes without persisting a user npmrc or touching system packages.
        env["NPM_CONFIG_PREFIX"] = prefix
        env["npm_config_prefix"] = prefix
        env["NPM_CONFIG_CACHE"] = os.path.join(prefix, "cache")
        env["npm_config_cache"] = env["NPM_CONFIG_CACHE"]
        system, arch = runtime_target(pair)
        if system in {"win32", "darwin", "linux"} and arch:
            # Environment precedence also overrides foreign targets in npmrc.
            for name, value in (("OS", system), ("CPU", arch)):
                env["NPM_CONFIG_" + name] = value
                env["npm_config_" + name.lower()] = value
            # A user npmrc can also request a foreign Linux libc. Prefer the
            # selected Node's observed loader without guessing unknown hosts.
            if system == pair.get("platform") == "linux" and pair.get("libc") in {"glibc", "musl"}:
                env["NPM_CONFIG_LIBC"] = env["npm_config_libc"] = pair["libc"]
    if install:
        from . import managed_agent_network
        proxies = managed_agent_network._proxies()
        # npm honors HTTP(S)_PROXY but cannot discover Windows Internet Options
        # by itself. npmrc's own proxy settings retain their normal precedence.
        for scheme in ("http", "https", "no"):
            name = scheme.upper() + "_PROXY"
            if not any(key.lower() == name.lower() for key in env) and proxies.get(scheme):
                env[name] = proxies[scheme]
        source = {key.lower(): value for key, value in env.items()}
        # An empty HTTPS_PROXY otherwise falls through to HTTP_PROXY in npm.
        if source.get("https_proxy") == "" and "npm_config_https_proxy" not in source:
            env["NPM_CONFIG_HTTPS_PROXY"] = "false"
    return env


def activate_environment(data_root: str = "") -> None:
    """Restore installed CLI visibility on Runner startup; no IO mutations."""
    prefix = private_prefix(data_root)
    if prefix:
        path = private_bin_dir(prefix)
        if os.path.isdir(path):
            os.environ["PATH"] = os.pathsep.join(dict.fromkeys([path, *os.environ.get("PATH", "").split(os.pathsep)]))
    pair = resolve()
    if pair.get("nodePath") and pair.get("npm"):
        os.environ["PATH"] = environment(pair)["PATH"]


def node_env(key: str = "", *, engine: str = "") -> dict:
    import socket
    pair = resolve()
    required = NODE_MINIMUMS.get(key, (0, 0, 0))
    # Existing package versions can legitimately support an older runtime than
    # today's install target. Only accept the simple official minimum form;
    # npm itself evaluates the complete semver range during installation.
    if re.fullmatch(r">=\d+(?:\.\d+){0,2}", engine.strip()):
        required = version_tuple(engine.strip()[2:])
    actual = version_tuple(pair.get("node", ""))
    has_runtime = bool(pair.get("nodePath") and pair.get("npm"))
    compatible = not any(required) or actual >= required
    why = ""
    if not has_runtime:
        why = "Runner 需要可独立运行的 Node.js 和 npm；客户端内置 Electron 不能替代 npm 运行环境。"
    elif not compatible:
        why = f"Node.js {pair.get('node', 'unknown')} 不满足 {key} 要求，需要 >= {'.'.join(map(str, required))}。"
    from .local_base import _npm_root
    return {**pair, "node": pair.get("node", ""), "npm": pair.get("npm", ""),
            "nodePath": pair.get("nodePath", ""), "npmRoot": private_root() or _npm_root(),
            "nodeMajor": actual[0], "requiredNode": ".".join(map(str, required)) if any(required) else "",
            "ok": has_runtime and compatible, "why": why, "host": socket.gethostname()}
