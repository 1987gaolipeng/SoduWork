"""Dependency preparation and source isolation for the local source launcher.

Only generated application directories are synchronized. Runtime uploads,
databases and private settings are never replaced by a source refresh.
"""
from __future__ import annotations

import hashlib
from functools import lru_cache
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import platform
import re
import tempfile
import time

from .local_path_check import check_windows_source_paths


ROOT = Path(__file__).resolve().parents[2]
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "outputs", "work"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".log", ".db", ".db-shm", ".db-wal"}
BACKEND_FILES = (
    "requirements.txt", "requirements-runner.txt", "alembic.ini", "runner_main.py", "db_admin.py",
    "full_backup.py", "pack_plugin.py", "client-update-trust.json",
)
ELECTRON_DOWNLOAD_TIMEOUT = 600
NPM_PROBE_TIMEOUT = 15
NPM_VERSION = re.compile(rb"v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
                         rb"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")


class StartupError(RuntimeError):
    """A recoverable setup failure with a user-facing explanation."""


class DiskFullError(StartupError):
    """A storage failure that must not be replaced with download advice."""


def electron_download_timeout() -> float:
    """Electron download deadline in seconds; honor ELECTRON_DOWNLOAD_TIMEOUT.

    docs/getting-started.md documents this variable as a way for slow
    connections to raise the 600-second deadline, so read it at use time
    instead of relying on the module constant. Invalid values fail loudly
    rather than being silently ignored.
    """
    raw = os.environ.get('ELECTRON_DOWNLOAD_TIMEOUT', '').strip()
    if not raw:
        return float(ELECTRON_DOWNLOAD_TIMEOUT)
    try:
        value = float(raw)
    except ValueError:
        raise StartupError(
            'ELECTRON_DOWNLOAD_TIMEOUT must be a positive number of seconds; '
            'got a non-numeric value'
        ) from None
    if not math.isfinite(value) or value <= 0:
        raise StartupError(
            'ELECTRON_DOWNLOAD_TIMEOUT must be a positive, finite number of seconds'
        )
    return value


def command_failure(message: str, log: Path, offset: int) -> StartupError:
    """Classify only this attempt, without echoing potentially private output."""
    prefix = f"{message}. See {log}. "
    try:
        with log.open('rb') as output:
            output.seek(offset)
            tail = b''
            while chunk := output.read(65536):
                text = tail + chunk
                if re.search(rb'\bENOSPC\b|\[Errno 28\]|\[WinError 112\]|'
                             rb'No space left on device|not enough space on the disk', text, re.I):
                    return DiskFullError(prefix + '磁盘空间不足 / Disk full. '
                                         'Free space on the data, cache or temporary-directory volume '
                                         'and retry; completed steps are reused.')
                tail = text[-128:]
    except OSError:
        pass  # Preserve the command failure even if its log cannot be read.
    return StartupError(prefix + 'Check the failing step in the log for the cause and retry; '
                        'completed steps are reused.')


def stop_child(child: subprocess.Popen) -> None:
    """Reap only this launcher's child tree, including npm's build subprocesses."""
    if child.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    else:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            os.killpg(child.pid, signal.SIGKILL)
        else:
            child.kill()
        child.wait(timeout=5)


def spawn_options() -> dict:
    return ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
            else {"start_new_session": True})


def wait_child(child: subprocess.Popen, *, progress_label: str | None = None,
               timeout: float | None = None) -> int:
    # Windows' infinite WaitForSingleObject defers Python signal handlers.
    # Bounded waits keep Ctrl+C responsive during both installs and serving.
    started = last_progress = time.monotonic()
    while True:
        try:
            return child.wait(timeout=.5)
        except subprocess.TimeoutExpired:
            now = time.monotonic()
            if timeout is not None and now - started >= timeout:
                raise subprocess.TimeoutExpired(child.args, timeout)
            if progress_label and now - last_progress >= 15:
                print(f"  正在进行 / Still running: {progress_label} ({int(now - started)}s). "
                      "请保持窗口打开 / Keep this window open.", flush=True)
                last_progress = now


def run(command: list[str], *, cwd: Path, log: Path, label: str,
        env: dict | None = None, timeout: float | None = None) -> None:
    print(label, flush=True)
    started = time.monotonic()
    with log.open("ab") as output:
        output.write(("\n--- " + label + " ---\n").encode("utf-8"))
        output.flush()
        offset = output.tell()
        with subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=output,
                              stderr=subprocess.STDOUT, **spawn_options()) as child:
            try:
                code = wait_child(child, progress_label=label, timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                stop_child(child)
                raise command_failure(f"{label} timed out after {timeout:g}s", log, offset) from exc
            except BaseException:
                stop_child(child)
                raise
    if code:
        raise command_failure(f"{label} failed (exit {code})", log, offset)
    print(f"  完成 / Done ({time.monotonic() - started:.1f}s)", flush=True)


def _check_npm_version(npm: str) -> None:
    command = [npm, "--version"]
    try:
        # A Windows npm.cmd can leave a child holding stdout. A temporary file
        # lets us wait for the command with a deadline without waiting for pipe EOF.
        with tempfile.TemporaryFile() as output:
            with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                  stderr=subprocess.DEVNULL, **spawn_options()) as child:
                try:
                    code = child.wait(timeout=NPM_PROBE_TIMEOUT)
                except BaseException:
                    stop_child(child)
                    raise
            output.seek(0)
            # Banners can use a different encoding from the terminal.
            if code == 0 and any(NPM_VERSION.fullmatch(line.strip()) for line in output):
                return
    except subprocess.TimeoutExpired as exc:
        raise StartupError(f"npm --version timed out after {NPM_PROBE_TIMEOUT}s. Check the npm command on PATH.") from exc
    except OSError as exc:
        raise StartupError("Cannot run npm --version. Check the npm command on PATH.") from exc
    raise StartupError("npm --version failed or returned no version. Check the npm command on PATH.")


def _probe_dependencies() -> tuple[str, str, str]:
    if sys.version_info < (3, 12):
        raise StartupError("Python 3.12 or newer is required: https://www.python.org/downloads/")
    node, npm = shutil.which("node"), shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not node or not npm:
        raise StartupError("请先安装 Node.js 22.19+，安装后关闭并重新打开启动窗口。\n"
                           "Install Node.js 22.19 or newer: https://nodejs.org/; then reopen this terminal.")
    try:
        version = subprocess.check_output([node, "--version"], text=True,
                                          timeout=15, **spawn_options()).strip()
        parsed = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version)
        if parsed is None or tuple(map(int, parsed.groups())) < (22, 19, 0):
            raise ValueError(version)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        raise StartupError("Node.js 22.19 or newer is required. Check node --version.") from exc
    _check_npm_version(npm)
    return node, npm, version


def check_dependencies() -> tuple[str, str]:
    node, npm, _ = _probe_dependencies()
    return node, npm


def check_desktop_session() -> None:
    if not sys.platform.startswith('linux'):
        return
    if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        raise StartupError("Desktop startup requires a graphical Linux session. Use start.py without --desktop on a server.")
    if os.geteuid() == 0:
        raise StartupError("Linux desktop startup cannot run as root. Run as the ordinary user logged into a graphical session, "
                           "or use start.py without --desktop for a headless service.")


def dependency_report(*, desktop: bool = False) -> None:
    """Read-only prerequisite check; never initialize an instance or install software."""
    _, npm, version = _probe_dependencies()
    print(f"Python: {platform.python_version()} ({sys.executable})")
    print(f"Node.js: {version}")
    print(f"npm: {npm}\nPlatform: {platform.system()} {platform.machine()}")
    if desktop:
        check_desktop_session()
        print("Desktop: Electron will be installed in this instance's private application directory.")
    print("Prerequisites are ready. First-time setup needs internet access; no files were changed.")


@lru_cache(maxsize=1)
def checkout_files() -> set[Path] | None:
    """Honor Git's ignored/untracked boundary when running a development checkout.

    Official source archives contain only shipped source and need no Git binary.
    A checkout must not import a developer's ignored screenshots or private files.
    """
    git = shutil.which("git")
    if not git or not (ROOT / ".git").exists():
        return None
    try:
        output = subprocess.check_output([git, "-C", str(ROOT), "ls-files", "-co",
                                          "--exclude-standard", "-z"], timeout=20,
                                         stderr=subprocess.DEVNULL, **spawn_options())
    except subprocess.SubprocessError as exc:
        raise StartupError("Cannot inspect source checkout files. Check Git access or use a clean source archive.") from exc
    return {ROOT / item.decode("utf-8") for item in output.split(b"\0") if item}


def source_files(source: Path):
    """Do not follow user symlinks or copy ignored credentials/runtime files."""
    manifest = checkout_files() if source.is_relative_to(ROOT) else None
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in SKIP_DIRS
                         and not name.startswith(".") and not (Path(directory) / name).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink() or name.startswith(".env") or path.suffix in SKIP_SUFFIXES:
                continue
            if manifest is not None and path not in manifest:
                continue
            yield path


def source_copy_targets():
    """Relative destinations of the source files copied by prepare()."""
    directories = ("hub-backend/app", "hub-backend/migrations", "hub-backend/installers",
                   "hub-backend/plugins", "skills", "client", "third-party",
                   "hub-frontend/src", "hub-frontend/public")
    for name in directories:
        for source in source_files(ROOT / name):
            yield Path("application") / source.relative_to(ROOT)
    for name in BACKEND_FILES:
        if (ROOT / "hub-backend" / name).is_file():
            yield Path("application/hub-backend") / name
    for name in ("package.json", "package-lock.json", "index.html", "vite.config.js"):
        if (ROOT / "hub-frontend" / name).is_file():
            yield Path("application/hub-frontend") / name
    if (ROOT / "tools/dev/local_server.py").is_file():
        yield Path("application/hub-backend/_soduwork_source_server.py")
    if (ROOT / "LICENSE").is_file():
        yield Path("application/LICENSE")


def sync_source(source: Path, target: Path, *, preserve: frozenset[str] = frozenset()) -> None:
    """Target is a dedicated generated-code directory, never a runtime root."""
    target.mkdir(parents=True, exist_ok=True)
    wanted = set()
    for path in source_files(source):
        relative = path.relative_to(source)
        wanted.add(relative)
        dest = target / relative
        for parent in reversed(relative.parents):
            directory = target / parent
            if directory.is_file():
                directory.unlink()
            directory.mkdir(exist_ok=True)
        if dest.is_dir():
            shutil.rmtree(dest)
        if not dest.exists() or path.read_bytes() != dest.read_bytes():
            shutil.copyfile(path, dest)
    for directory, dirs, files in os.walk(target, followlinks=False):
        if Path(directory) == target:
            dirs[:] = [name for name in dirs if name not in preserve]
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()
                   and not (Path(directory) / name).is_junction()]
        for name in files:
            path = Path(directory) / name
            if path.relative_to(target) not in wanted:
                path.unlink()


def digest_files(files, root: Path) -> str:
    result = hashlib.sha256()
    for file in sorted(files):
        result.update(file.relative_to(root).as_posix().encode("utf-8") + b"\0")
        result.update(file.read_bytes())
    return result.hexdigest()


def read_stamp(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip() if path.is_file() else ""


def verify_runner_environment(python: Path, backend: Path, log: Path, *, env: dict) -> None:
    """Check imports and the control-channel API without starting a Runner."""
    probe = ("import inspect, sys, websockets, yaml, pg8000, pymysql, pymongo, dns, redis, cryptography, truststore\n"
             "assert sys.version_info >= (3, 12), 'Runner requires Python 3.12+'\n"
             "assert {'additional_headers', 'proxy'} <= set(inspect.signature(websockets.connect).parameters), "
             "'Runner requires the websockets 15+ connection API'\n")
    run([str(python), "-I", "-c", probe], cwd=backend, log=log, timeout=60, env=env,
        label="[Runner] 检查本地运行环境 / Checking the local Runner environment")


def prepare_environment(state: Path) -> dict[str, str]:
    """Isolate install caches and temporary files before runtime HOME isolation."""
    cache = state / "cache"
    temporary = cache / "tmp"
    temporary.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    # Windows environment names and npm configuration keys are case-insensitive.
    for key, value in (("npm_config_cache", cache / "npm"), ("PIP_CACHE_DIR", cache / "pip"),
                       ("electron_config_cache", cache / "electron")):
        name = next((name for name in env if name.lower() == key.lower()), key) \
            if os.name == 'nt' or key == 'npm_config_cache' else key
        if not env.get(name):
            env[name] = str(value)
    # TEMP/TMP are normally set to the system drive on Windows. Override them
    # only in preparation children; merely supplying defaults would not isolate it.
    env.update({key: str(temporary) for key in ('TMPDIR', 'TEMP', 'TMP')})
    return env


def venv_interpreter_error(python: Path, venv: Path, log: Path) -> StartupError:
    """Explain a missing venv interpreter, and record the same reason in the log.

    A venv command can report success while producing a layout this launcher cannot
    use. Every later step only names this log file, so the diagnosis has to be there
    too, not just on the terminal.
    """
    posix = next((candidate for candidate in (venv / "bin" / "python.exe", venv / "bin" / "python")
                  if candidate.is_file()), None)
    facts = [
        f"expected interpreter: {python}",
        f"interpreter that created the venv: {sys.executable}",
        f"os.name={os.name}",
    ]
    if posix is not None:
        facts.append(f"interpreter found in a POSIX layout: {posix}")
    # Claim an MSYS2/Cygwin layout only when the POSIX interpreter is really there,
    # so other platforms get the actual missing path instead of Windows advice.
    if os.name == "nt" and posix is not None:
        message = (
            f"独立环境没有生成 {python}，但在 {posix} 找到了 POSIX 布局的解释器。当前解释器 "
            f"{sys.executable} 可能是 MSYS2/Cygwin 版本，它创建的 venv 使用 bin/ 而不是 Scripts/。"
            "请改用 python.org 的官方 Windows 版（或 py -3.12）后重跑同一入口；"
            "已经创建的数据目录会直接复用，不需要删除。\n"
            f"The private environment does not contain {python}, but a POSIX-layout interpreter exists at "
            f"{posix}. {sys.executable} looks like an MSYS2/Cygwin build, whose venv uses bin/ instead of "
            "Scripts/. Use a native python.org Windows build (or py -3.12) and run the same launcher again; "
            "the existing data directory is reused.")
    else:
        message = (
            f"独立环境没有生成 {python}。创建 venv 的解释器是 {sys.executable}（os.name={os.name}）。"
            "请确认这个解释器可以正常执行 `-m venv`，修复后重跑同一入口；"
            "已经创建的数据目录会直接复用，不需要删除。\n"
            f"The private environment does not contain {python}. The interpreter that created it was "
            f"{sys.executable} (os.name={os.name}). Check that this interpreter can run `-m venv`, then run "
            "the same launcher again; the existing data directory is reused.")
    details = "\n".join(facts)
    try:
        with log.open("ab") as output:
            output.write(("\n--- 独立环境诊断 / private environment diagnosis ---\n"
                          + details + "\n" + message + "\n").encode("utf-8"))
    except OSError:
        pass  # A diagnosis must never mask the original failure.
    return StartupError(message + "\n" + details)


def prepare(state: Path, log: Path) -> tuple[Path, Path]:
    check_windows_source_paths(state, source_copy_targets(), probe=True)
    _, npm = check_dependencies()
    cache_env = prepare_environment(state)
    runtime = state / "application"
    backend = runtime / "hub-backend"
    backend.mkdir(parents=True, exist_ok=True)
    for name in ("app", "migrations", "installers", "plugins"):
        sync_source(ROOT / "hub-backend" / name, backend / name)
    for name in BACKEND_FILES:
        shutil.copyfile(ROOT / "hub-backend" / name, backend / name)
    shutil.copyfile(ROOT / "tools/dev/local_server.py", backend / "_soduwork_source_server.py")
    sync_source(ROOT / "skills", runtime / "skills")
    # hub-frontend builds reference client source with relative imports (for example, ConnectorIcon.jsx ->
    # ../../../client/core/connector-brand.js), so the isolated runtime must preserve the same layout.
    sync_source(ROOT / "client", runtime / "client",
                preserve=frozenset({'node_modules', '.runtime', '.runtime-cache'}))
    sync_source(ROOT / "third-party", runtime / "third-party")
    shutil.copyfile(ROOT / "LICENSE", runtime / "LICENSE")

    venv = state / "venv"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    # Keep the caller's module paths out of pip and its build subprocesses.
    python_env = {key: value for key, value in cache_env.items() if key not in ("PYTHONHOME", "PYTHONPATH")}
    if not python.is_file():
        run([sys.executable, "-I", "-m", "venv", str(venv)], cwd=state, log=log, env=python_env,
            label="[1/4] 创建独立环境 / Creating a private Python environment")
        if not python.is_file():
            raise venv_interpreter_error(python, venv, log)
    requirements = [ROOT / "hub-backend" / name for name in ("requirements.txt", "requirements-runner.txt")]
    py_stamp = state / "python-dependencies.sha256"
    wanted = digest_files(requirements, ROOT)
    install = read_stamp(py_stamp) != wanted
    if not install:
        try:
            verify_runner_environment(python, backend, log, env=python_env)
        except DiskFullError:
            raise
        except StartupError:
            # A stamp is not proof that packages still import. Repair only this
            # launcher's environment, never a checkout or activated shell venv.
            install = True
    if install:
        run([str(python), "-I", "-m", "pip", "install", "--disable-pip-version-check",
             *[argument for file in requirements for argument in ("-r", str(file))]], cwd=state, log=log,
            env=python_env,
            label="[2/4] 安装服务依赖 / Installing server dependencies (first run needs internet)")
        verify_runner_environment(python, backend, log, env=python_env)
        py_stamp.write_text(wanted, encoding="utf-8")

    source = ROOT / "hub-frontend"
    frontend = runtime / "hub-frontend"
    frontend.mkdir(parents=True, exist_ok=True)
    for name in ("src", "public"):
        if (source / name).is_dir():
            sync_source(source / name, frontend / name)
    for name in ("package.json", "package-lock.json", "index.html", "vite.config.js"):
        shutil.copyfile(source / name, frontend / name)
    npm_stamp = state / "node-dependencies.sha256"
    wanted = hashlib.sha256((source / "package-lock.json").read_bytes()).hexdigest()
    if read_stamp(npm_stamp) != wanted or not (frontend / "node_modules/vite").is_dir():
        run([npm, "ci", "--include=dev", "--no-audit", "--no-fund"], cwd=frontend, log=log,
            env=cache_env,
            label="[3/4] 安装页面依赖 / Installing management UI dependencies")
        npm_stamp.write_text(wanted, encoding="utf-8")
    build_stamp = state / "frontend.sha256"
    files = [source / name for name in ("package.json", "package-lock.json", "index.html", "vite.config.js")]
    for name in ("src", "public"):
        if (source / name).is_dir():
            files.extend(source_files(source / name))
    files.extend((ROOT / "client" / name) for name in (
        "core/connector-brand.js", "core/locales/builtin-skills.js", "components/panels/connector-config.js",
        "components/client-auth/legal-html.js", "components/client-auth/legal-html.css"))
    files.extend(source_files(ROOT / "client/assets/connector-brands"))
    wanted = digest_files(files, ROOT)
    if read_stamp(build_stamp) != wanted or not (frontend / "dist/index.html").is_file():
        run([npm, "run", "build"], cwd=frontend, log=log,
            env=cache_env,
            label="[4/4] 构建管理页面 / Building the management UI")
        build_stamp.write_text(wanted, encoding="utf-8")
    return python, backend


def electron_binary(client: Path) -> Path:
    relative = ('electron.exe' if os.name == 'nt' else
                'Electron.app/Contents/MacOS/Electron' if sys.platform == 'darwin' else 'electron')
    return client / 'node_modules/electron/dist' / relative


def electron_install_environment(environment: dict | None = None) -> dict[str, str]:
    """Enable the locked downloader's proxy only in its installation process."""
    env = dict(os.environ if environment is None else environment)
    switch = env.get('ELECTRON_GET_USE_PROXY')
    if switch is None:
        # Match EnvHttpProxyAgent: lowercase, including an empty value, wins.
        proxy = any(env.get(name.lower(), env.get(name, '')).strip()
                    for name in ('HTTP_PROXY', 'HTTPS_PROXY'))
        if proxy:
            env['ELECTRON_GET_USE_PROXY'] = '1'
    else:
        # @electron/get treats every nonempty string (even "false") as true.
        env['ELECTRON_GET_USE_PROXY'] = ('' if switch.strip().lower() in
                                        {'', '0', 'false', 'no', 'off'} else '1')
    return env


def prepare_desktop(state: Path, log: Path) -> Path:
    """Install only in the launcher's generated copy, leaving the checkout untouched."""
    node, npm = check_dependencies()
    check_desktop_session()
    cache_env = prepare_environment(state)
    client = state / 'application/client'
    stamp = state / 'desktop-dependencies.sha256'
    wanted = hashlib.sha256((client / 'package-lock.json').read_bytes()).hexdigest()
    if read_stamp(stamp) != wanted or not electron_binary(client).is_file():
        run([npm, 'ci', '--include=dev', '--no-audit', '--no-fund', '--ignore-scripts'], cwd=client, log=log,
            env=cache_env,
            label='[Desktop] 安装桌面端 / Installing the desktop application (first run needs internet)')
        # npm versions differ in install-script policy. Download the locked Electron
        # runtime explicitly without enabling unrelated dependencies' lifecycle scripts.
        if not electron_binary(client).is_file():
            print("桌面运行环境下载最多等待 10 分钟 / Electron download allows up to 10 minutes. "
                  "If GitHub is unreachable, configure ELECTRON_MIRROR or your proxy and retry.", flush=True)
            try:
                run([node, str(client / 'scripts/install-electron.cjs')], cwd=client, log=log,
                    label='[Desktop] 下载桌面运行环境 / Downloading the Electron runtime',
                    env=electron_install_environment(cache_env),
                    timeout=electron_download_timeout())
            except DiskFullError:
                raise
            except StartupError as exc:
                raise StartupError(
                    f"{exc}\nElectron 准备失败；先查看日志中的具体原因。仅网络连接失败时检查代理或 ELECTRON_MIRROR。\n"
                    "If the log reports a download connection failure, check your proxy or set "
                    "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ in your shell "
                    "if that mirror is reachable, then run the same launcher again. "
                    "See docs/getting-started.md for shell-specific commands."
                ) from exc
        if not electron_binary(client).is_file():
            raise StartupError(f"Electron was not downloaded. Check npm install-script policy and {log}; then retry.")
        stamp.write_text(wanted, encoding='utf-8')
    if sys.platform == 'win32':
        # Electron's dependency stamp does not cover the Shell payload. The
        # preparation script verifies its own manifest and probes the tools on
        # every launch, reusing the verified payload or an interrupted download.
        run([node, str(client / 'scripts/prepare-shell-runtime.cjs')], cwd=client, log=log,
            env=cache_env,
            label='[Desktop] 准备命令运行环境 / Preparing the command runtime')
    return client
