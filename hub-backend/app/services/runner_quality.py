"""Runner quality-gate executor accepting structured argv only, never shell command strings."""
from __future__ import annotations

import json
import os
import queue
import re
import signal
import shutil
import subprocess
import threading
import time
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

_LOCK = threading.RLock()
_ACTIVE: set[str] = set()
_MAX_LOG = 1024 * 1024
_CONFIGURATION_HINTS = (
    "authentication failed", "unauthorized", "could not read username",
    "permission denied (publickey", "repository not found", "403 forbidden",
)
_INFRASTRUCTURE_HINTS = (
    "buildkit is enabled but the buildx component is missing",
    "buildx component is missing or broken", "cannot connect to the docker daemon",
    "error during connect", "is the docker daemon running", "docker daemon is not running",



    "failed to connect to the docker api", "dockerdesktoplinuxengine",
    "check if the path is correct and if the daemon is running",
    "network is unreachable", "temporary failure in name resolution",
    "could not resolve host", "tls handshake timeout", "connection reset by peer",
    "no space left on device", "context deadline exceeded",


    "premature end of content-length delimited message body",
    "could not transfer artifact", "failed to transfer",
    "connection timed out", "read timed out", "unknown host",
)
_GIT_CONFLICT_LINE = re.compile(
    r"(?m)^(?:<<<<<<<[ \t].+|=======[ \t]*|>>>>>>>[ \t].+)\r?$"
)


def _failure_kind(error: str, checks: list[dict]) -> str:
    """Classify only failures whose remedy is outside the submitted source code."""
    declared = next((str(item.get("failureKind") or "") for item in reversed(checks)
                     if item.get("failureKind")), "")
    if declared:
        return declared
    text = " ".join([str(error or "")] + [str(item.get("detail") or "") for item in checks]).lower()
    if any(hint in text for hint in _CONFIGURATION_HINTS):
        return "configuration"
    if any(hint in text for hint in _INFRASTRUCTURE_HINTS):
        return "infrastructure"
    return ""


def _root() -> str:
    from .local_base import _data_root
    path = os.path.join(_data_root(), "quality")
    os.makedirs(path, exist_ok=True)
    return path


def _id(value: str) -> str:
    value = str(value or "")
    if not re.fullmatch(r"[A-Za-z0-9-]{6,80}", value):
        raise ValueError("质量运行号不合法")
    return value


def _state_path(run_id: str) -> str:
    return os.path.join(_root(), _id(run_id) + ".json")


def _log_path(run_id: str) -> str:
    return os.path.join(_root(), _id(run_id) + ".log")


def _save(state: dict) -> None:
    path = _state_path(state["id"])
    tmp = path + ".tmp"
    # Windows antivirus or indexing can briefly retain a file handle after a read.
    # Serialize local reads and writes, then briefly retry atomic replacement.
    with _LOCK:
        for attempt in range(6):
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(state, f, ensure_ascii=False, separators=(",", ":"))
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt >= 5:
                    raise
                time.sleep(0.02 * (attempt + 1))


def _load(run_id: str) -> dict | None:
    with _LOCK:
        for attempt in range(4):
            try:
                with open(_state_path(run_id), encoding="utf-8") as f:
                    return json.load(f)
            except PermissionError:
                if attempt < 3:
                    time.sleep(0.01)
                    continue
                return None
            except (FileNotFoundError, ValueError, json.JSONDecodeError, OSError):
                return None
    return None


def _append(run_id: str, text: str) -> None:
    with open(_log_path(run_id), "a", encoding="utf-8", errors="replace") as f:
        f.write(str(text or ""))
        if text and not str(text).endswith("\n"):
            f.write("\n")
    try:
        path = _log_path(run_id)
        if os.path.getsize(path) > _MAX_LOG * 2:
            with open(path, "rb") as f:
                f.seek(-_MAX_LOG, os.SEEK_END)
                tail = f.read()
            with open(path, "wb") as f:
                f.write(tail)
    except OSError:
        pass


def _argv(value) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > 80:
        raise ValueError("质量命令必须是非空 argv 数组")
    out = [str(x or "")[:500] for x in value]
    if any(not x for x in out):
        raise ValueError("质量命令含空参数")
    return out


# Semantic JavaScript build steps.
# Resolve install and build commands from the repository's current package-manager configuration.
# Do not translate npm commands through string substitution because flags differ between managers.
# Static commands can become invalid after a repository changes package managers.
# Resolve the manager before validating or installing dependencies.
# Detect it in each command's workingDir for monorepo subpackages.
_JS_STEPS: dict[str, dict[str, tuple[str, ...]]] = {
    "npm": {
        "js:install": ("npm", "install", "--no-save"),
        "js:ci": ("npm", "ci", "--prefer-offline"),
        "js:build": ("npm", "run", "build"),
        "js:test": ("npm", "run", "test"),
        "js:type-check": ("npm", "run", "type-check"),
    },
    "pnpm": {
        # Dependency installation must not generate an alternate lockfile or alter reviewed source.
        # Avoid recreating invalid lockfiles removed during rework.
        "js:install": ("corepack", "pnpm", "install", "--lockfile=false"),
        "js:ci": ("corepack", "pnpm", "install", "--frozen-lockfile"),
        "js:build": ("corepack", "pnpm", "run", "build"),
        "js:test": ("corepack", "pnpm", "run", "test"),
        "js:type-check": ("corepack", "pnpm", "run", "type-check"),
    },
    "yarn": {
        "js:install": ("corepack", "yarn", "install"),
        "js:ci": ("corepack", "yarn", "install", "--immutable"),
        "js:build": ("corepack", "yarn", "run", "build"),
        "js:test": ("corepack", "yarn", "run", "test"),
        "js:type-check": ("corepack", "yarn", "run", "type-check"),
    },
}


def _detect_pm(workdir: str) -> str:
    """Choose package manager by packageManager, then lockfile, then npm. Manifest declarations
    outrank stale lockfiles left after migration.
    """
    pkg = os.path.join(workdir, "package.json")
    if os.path.isfile(pkg):
        try:
            with open(pkg, encoding="utf-8") as f:
                declared = str(json.load(f).get("packageManager") or "")
        except (OSError, ValueError):
            declared = ""
        name = declared.split("@", 1)[0].strip().lower()
        if name in _JS_STEPS:
            return name
    if os.path.isfile(os.path.join(workdir, "pnpm-lock.yaml")):
        return "pnpm"
    if os.path.isfile(os.path.join(workdir, "yarn.lock")):
        return "yarn"
    return "npm"


def _resolve_step(argv: list[str], workdir: str) -> list[str]:
    """Expand single-item js:* semantic commands into argv, leaving unknown steps to fail visibly.
    Resolve Windows command shims through which and fall back to direct pnpm/yarn when Corepack
    is absent.
    """
    if len(argv) != 1 or not argv[0].startswith("js:"):
        return argv
    steps = _JS_STEPS[_detect_pm(workdir)]
    resolved = steps.get(argv[0])
    if resolved is None:
        return argv
    out = list(resolved)
    if out[0] == "corepack" and not shutil.which("corepack"):
        out = out[1:]                      # Invoke the package manager directly when Corepack is unavailable.
    exe = shutil.which(out[0])
    if exe:
        out[0] = exe
    return out


def _detect_project_profile(workdir: str) -> str:
    if os.path.isfile(os.path.join(workdir, "pom.xml")):
        return "maven"
    if any(os.path.isfile(os.path.join(workdir, name))
           for name in ("build.gradle", "build.gradle.kts", "gradlew", "gradlew.bat")):
        return "gradle"
    if os.path.isfile(os.path.join(workdir, "package.json")):
        return "node"
    if any(os.path.isfile(os.path.join(workdir, name))
           for name in ("pyproject.toml", "pytest.ini", "setup.cfg", "requirements.txt")):
        return "python"
    if os.path.isfile(os.path.join(workdir, "index.html")):
        return "static-web"
    return ""


_STATIC_FILE_SUFFIXES = {
    ".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg",
    ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".txt", ".map",
}


class _StaticAssets(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.refs: list[tuple[str, str]] = []

    def handle_starttag(self, _tag, attrs):
        for key, value in attrs:
            if key in ("src", "href") and value:
                self.refs.append((key, str(value)))


def _static_site_test(run_id: str, workdir: str) -> list[dict]:
    """Validate a dependency-free website without inventing a fake build command."""
    started = time.time()
    root = os.path.realpath(workdir)
    html_files: list[str] = []
    text_files: list[str] = []
    for current, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in (".git", "node_modules")]
        for name in files:
            path = os.path.join(current, name)
            suffix = os.path.splitext(name)[1].lower()
            if suffix == ".html":
                html_files.append(path)
            if suffix in {".html", ".css", ".js", ".json"}:
                text_files.append(path)
        if len(text_files) > 1000:
            break
    problems: list[str] = []
    if not html_files:
        problems.append("没有找到 HTML 页面")
    for path in text_files[:1000]:
        try:
            with open(path, encoding="utf-8") as stream:
                text = stream.read()
        except (OSError, UnicodeError) as exc:
            problems.append("%s 无法按 UTF-8 读取（%s）" % (
                os.path.relpath(path, root), type(exc).__name__))
            continue
        # Git only writes conflict markers as complete lines.  Decorative separators such as
        # ``/* ======= section ======= */`` are valid HTML/CSS/JS and must not fail a release.
        if _GIT_CONFLICT_LINE.search(text):
            problems.append("%s 留有 Git 冲突标记" % os.path.relpath(path, root))
        if path not in html_files:
            continue
        parser = _StaticAssets()
        try:
            parser.feed(text)
        except Exception as exc:  # noqa: BLE001
            problems.append("%s HTML 解析失败（%s）" % (
                os.path.relpath(path, root), type(exc).__name__))
            continue
        for attr, raw in parser.refs:
            value = raw.strip()
            if not value or value.startswith(("#", "data:", "mailto:", "tel:", "javascript:")):
                continue
            parsed = urlsplit(value)
            if parsed.scheme or parsed.netloc:
                continue
            rel = unquote(parsed.path)
            if not rel or rel.endswith("/"):
                continue
            suffix = os.path.splitext(rel)[1].lower()
            if attr == "href" and suffix not in _STATIC_FILE_SUFFIXES:
                continue
            candidate = (os.path.join(root, rel.lstrip("/"))
                         if rel.startswith("/")
                         else os.path.join(os.path.dirname(path), rel))
            candidate = os.path.realpath(candidate)
            if os.path.commonpath((root, candidate)) != root:
                problems.append("%s 引用了站点根目录外的资源 %s" % (
                    os.path.relpath(path, root), raw))
            elif not os.path.isfile(candidate):
                problems.append("%s 缺少本地资源 %s" % (
                    os.path.relpath(path, root), raw))
    detail = ("通过：%d 个 HTML 页面、%d 个文本资源引用完整" %
              (len(html_files), len(text_files))) if not problems else "；".join(problems[:20])
    _append(run_id, "\n[静态网站完整性] " + detail)
    return [{
        "name": "静态网站完整性", "ok": not problems,
        "exitCode": 0 if not problems else 1,
        "durationMs": int((time.time() - started) * 1000),
        "detail": detail[:2000],
    }]


def _run_argv(run_id: str, name: str, argv: list[str], cwd: str,
              env: dict, timeout: int) -> dict:
    resolved = _resolve_step(argv, cwd)
    _append(run_id, f"\n[{name}] $ " + " ".join(resolved))
    started = time.time()
    tail: list[str] = []
    code = 127
    try:
        proc = subprocess.Popen(
            resolved, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            bufsize=1, shell=False, start_new_session=os.name != "nt",
            creationflags=(getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0))
        updates: queue.Queue = queue.Queue()

        def read_output() -> None:
            try:
                for line in iter(proc.stdout.readline, ""):
                    updates.put(line)
            finally:
                updates.put(None)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        ended = False
        while not ended:
            if time.time() - started > timeout:
                code = 124
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, timeout=20, check=False)
                else:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except OSError:
                        proc.kill()
                break
            try:
                item = updates.get(timeout=0.25)
            except queue.Empty:
                if proc.poll() is not None and not reader.is_alive():
                    ended = True
                continue
            if item is None:
                ended = True
                continue
            _append(run_id, item)
            tail.append(item)
            if len(tail) > 200:
                del tail[:100]
        if code != 124:
            code = proc.wait(timeout=10)
        else:
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
    except OSError as exc:
        tail.append(type(exc).__name__ + ": " + str(exc))
        _append(run_id, tail[-1])
    if code == 124:
        tail.append(f"\n{name} 超时（{timeout}s）")
        _append(run_id, tail[-1])
    detail = "".join(tail)[-2000:] if tail else ("命令没有输出" if code else "通过")
    return {
        "name": name, "ok": code == 0, "exitCode": code,
        "durationMs": int((time.time() - started) * 1000), "detail": detail,
    }


def _failed_selftest(run_id: str, detail: str, failure_kind: str = "") -> list[dict]:
    _append(run_id, "\n[工程真实自测] " + detail)
    return [{"name": "工程真实自测", "ok": False, "exitCode": 127,
             "durationMs": 0, "detail": detail[:2000],
             **({"failureKind": failure_kind} if failure_kind else {})}]


def _docker_has_buildx(docker: str, env: dict) -> bool:
    """Probe this host per quality run; a later Runner upgrade may install buildx."""
    try:
        proc = subprocess.run(
            [docker, "buildx", "version"], env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=15, shell=False, check=False)
        return proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _docker_daemon_ready(docker: str, env: dict) -> tuple[bool, str]:
    """Probe Docker daemon readiness with a bounded docker info call; an installed CLI alone does
    not prove builds can run.
    """
    try:
        probe = subprocess.run([docker, "info", "--format", "{{.ServerVersion}}"],
                               capture_output=True, text=True, errors="replace",
                               timeout=10, env=env)
    except Exception as exc:  # noqa: BLE001
        return False, type(exc).__name__
    if probe.returncode == 0 and (probe.stdout or "").strip():
        return True, ""
    return False, ((probe.stderr or probe.stdout or "").strip().splitlines() or ["无输出"])[-1][:300]


def _docker_maven_test(run_id: str, workdir: str, env: dict, timeout: int) -> list[dict]:
    docker = shutil.which("docker")
    if not docker:
        return _failed_selftest(
            run_id, "识别到 Maven 工程，但执行机没有 Maven Wrapper、mvn 或 Docker",
            "infrastructure")
    daemon_ok, why = _docker_daemon_ready(docker, env)
    if not daemon_ok:
        # Classify daemon unavailability as infrastructure failure.
        # Do not request code rework for a stopped Docker service.
        return _failed_selftest(
            run_id, "识别到 Maven 工程，执行机有 Docker 但守护进程没有运行（%s）——"
                    "请在这台执行机上启动 Docker Desktop，或安装 Maven/JDK 后重试" % why,
            "infrastructure")
    generated = os.path.join(_root(), "dockerfiles")
    os.makedirs(generated, exist_ok=True)
    dockerfile = os.path.join(generated, run_id + ".Dockerfile")
    tag = "soduwork-quality-" + run_id.lower()
    docker_env = dict(env)
    buildkit = _docker_has_buildx(docker, docker_env)
    docker_env["DOCKER_BUILDKIT"] = "1" if buildkit else "0"
    with open(dockerfile, "w", encoding="utf-8") as stream:
        stream.write(
            "FROM maven:3.9-eclipse-temurin-17\n"
            "WORKDIR /workspace\n"
            "COPY . .\n"
            + ("RUN --mount=type=cache,id=soduwork-maven-repository-v1,target=/root/.m2 "
               if buildkit else "RUN ")
            + "mvn -B -ntp test\n")
    try:
        return [_run_argv(
            run_id, "Maven 工程测试（Docker）",
            [docker, "build", "--file", dockerfile, "--tag", tag, "."],
            workdir, docker_env, timeout)]
    finally:
        try:
            os.remove(dockerfile)
        except OSError:
            pass
        try:
            subprocess.run(
                [docker, "image", "rm", "--force", tag],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=120, shell=False, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _project_selftest(run_id: str, workdir: str, env: dict, timeout: int) -> list[dict]:
    profile = _detect_project_profile(workdir)
    _append(run_id, "\n[工程自测识别] " + (profile or "unknown"))
    if profile == "maven":
        wrapper = os.path.join(workdir, "mvnw.cmd" if os.name == "nt" else "mvnw")
        if os.path.isfile(wrapper):
            argv = ([wrapper, "-B", "-ntp", "test"] if os.name == "nt"
                    else ["sh", wrapper, "-B", "-ntp", "test"])
            return [_run_argv(run_id, "Maven Wrapper 测试", argv, workdir, env, timeout)]
        maven = shutil.which("mvn.cmd" if os.name == "nt" else "mvn")
        if maven:
            return [_run_argv(
                run_id, "Maven 工程测试", [maven, "-B", "-ntp", "test"],
                workdir, env, timeout)]
        return _docker_maven_test(run_id, workdir, env, timeout)
    if profile == "gradle":
        wrapper = os.path.join(workdir, "gradlew.bat" if os.name == "nt" else "gradlew")
        if os.path.isfile(wrapper):
            argv = ([wrapper, "--no-daemon", "test"] if os.name == "nt"
                    else ["sh", wrapper, "--no-daemon", "test"])
        else:
            gradle = shutil.which("gradle.bat" if os.name == "nt" else "gradle")
            if not gradle:
                return _failed_selftest(
                    run_id, "识别到 Gradle 工程，但执行机没有 Gradle Wrapper 或 gradle")
            argv = [gradle, "--no-daemon", "test"]
        return [_run_argv(run_id, "Gradle 工程测试", argv, workdir, env, timeout)]
    if profile == "node":
        try:
            with open(os.path.join(workdir, "package.json"), encoding="utf-8") as stream:
                scripts = dict(json.load(stream).get("scripts") or {})
        except (OSError, ValueError):
            scripts = {}
        meaningful_test = bool(scripts.get("test")) and "no test specified" not in str(
            scripts.get("test") or "").lower()
        steps = [["js:ci"] if any(os.path.isfile(os.path.join(workdir, name))
                                  for name in ("package-lock.json", "pnpm-lock.yaml", "yarn.lock"))
                 else ["js:install"]]
        if meaningful_test:
            steps.append(["js:test"])
        if scripts.get("build"):
            steps.append(["js:build"])
        if len(steps) == 1:
            return _failed_selftest(
                run_id, "Node 工程没有可执行的 test 或 build 脚本")
        names = ["安装锁定依赖"] + [
            "Node 测试" if step == ["js:test"] else "Node 构建" for step in steps[1:]]
        checks = []
        for name, argv in zip(names, steps):
            check = _run_argv(run_id, name, argv, workdir, env, timeout)
            checks.append(check)
            if not check["ok"]:
                break
        return checks
    if profile == "python":
        python = shutil.which("python3") or shutil.which("python")
        if not python:
            return _failed_selftest(run_id, "识别到 Python 工程，但执行机没有 Python")
        return [_run_argv(
            run_id, "Python 工程测试", [python, "-m", "pytest", "-q"],
            workdir, env, timeout)]
    if profile == "static-web":
        return _static_site_test(run_id, workdir)
    return _failed_selftest(
        run_id, "无法自动识别工程自测；请在插件绑定中配置结构化 qualityCommands")


def _git(repo_dir: str, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=repo_dir, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", timeout=120, shell=False)
    output = str(proc.stdout or "").strip()
    if proc.returncode != 0:
        raise ValueError((output or "Git 操作失败")[-800:])
    return output


def _immutable_checkout(spec: dict, run_id: str) -> tuple[str, str, str]:
    """Fetch the pushed branch into a clean mirror and detach exactly its audited commit."""
    source = dict(spec.get("repository") or {})
    expected = str(source.get("commit") or "").strip().lower()
    branch, target = str(source.get("branch") or ""), str(source.get("target") or "")
    if not re.fullmatch(r"[0-9a-f]{7,64}", expected):
        raise ValueError("质量门禁缺少合法的固定提交号")
    if not source.get("gitUrl") or not branch or not target:
        raise ValueError("质量门禁缺少仓库、工作分支或目标分支")
    from . import git_ops, runner_scm
    mirror, ready = runner_scm._ready(source)
    if not ready.get("ok"):
        raise ValueError(str(ready.get("error") or "质量镜像仓库没有准备好"))
    if branch.startswith("refs/"):
        # Gerrit candidates may use refs/changes rather than origin branches.
        # Fetch the exact ref and verify the fixed revision through FETCH_HEAD.
        from .code_creds import env_for as _cred_env
        env = _cred_env(dict(os.environ), dict(source.get("git") or {}),
                        ref=str(source.get("taskId") or run_id))
        proc = subprocess.run(
            ["git", "-c", "http.proxy=", "-c", "https.proxy=",
             "fetch", "origin", branch],
            cwd=mirror, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=300, shell=False)
        if proc.returncode != 0:
            raise ValueError(("拉取 Gerrit change ref 失败:"
                              + str(proc.stdout or ""))[-500:])
        actual = _git(mirror, "rev-parse", "FETCH_HEAD").strip().lower()
    else:
        info = git_ops.branch_commits(
            mirror, branch, target, 20, True, dict(source.get("git") or {}),
            str(source.get("taskId") or run_id))
        if not info.get("ok"):
            raise ValueError(str(info.get("error") or "读取远端代码版本失败"))
        actual = str(info.get("head") or "").strip().lower()
    if not actual or not (actual.startswith(expected) or expected.startswith(actual)):
        raise ValueError(
            "待检查提交与远端工作分支不一致（%s ≠ %s）" %
            (expected[:12], actual[:12] or "空"))
    checkout = os.path.join(_root(), "checkouts", run_id)
    os.makedirs(os.path.dirname(checkout), exist_ok=True)
    if os.path.exists(checkout):
        subprocess.run(["git", "worktree", "remove", "--force", checkout], cwd=mirror,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=60, shell=False)
        shutil.rmtree(checkout, ignore_errors=True)
    _git(mirror, "worktree", "add", "--detach", "--force", checkout, actual)
    return mirror, checkout, actual


def _drop_checkout(mirror: str, checkout: str) -> None:
    if mirror and checkout:
        subprocess.run(["git", "worktree", "remove", "--force", checkout], cwd=mirror,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=60, shell=False)
        subprocess.run(["git", "worktree", "prune"], cwd=mirror,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30, shell=False)
    if checkout:
        shutil.rmtree(checkout, ignore_errors=True)


def _command_dir(repo_dir: str, relative: str) -> str:
    """Resolve one gate command below the already validated repository root."""
    # Compare canonical paths: Windows checkouts can use forward slashes,
    # short names or a different drive-letter case than realpath returns.
    root = os.path.realpath(repo_dir)
    rel = str(relative or "").replace("\\", "/").strip()
    if not rel:
        return root
    if rel.startswith('/') or os.path.isabs(rel) or os.path.splitdrive(rel)[0] or ".." in rel.split("/"):
        raise ValueError("质量命令工作目录不合法")
    path = os.path.realpath(os.path.join(root, *rel.split("/")))
    if os.path.normcase(os.path.commonpath([root, path])) != os.path.normcase(root):
        raise ValueError("质量命令工作目录越过工程根目录")
    if not os.path.isdir(path):
        raise ValueError("质量命令工作目录不存在：" + rel)
    return path


def _worker(spec: dict, work_root: str) -> None:
    run_id = _id(spec.get("runId"))
    state = _load(run_id) or {"id": run_id}
    state.update(state="running", startedAt=int(time.time() * 1000), error="", result={},
                 failureKind="", failurePath="")
    _save(state)
    checks = []
    mirror = checkout = commit = ""
    try:
        if spec.get("hygiene"):
            from . import optional_internal_features
            optional_internal_features.require("change_hygiene")
        mirror, checkout, commit = _immutable_checkout(spec, run_id)
        repo_dir = checkout
        commands = list(spec.get("commands") or [])
        if not commands or len(commands) > 20:
            raise ValueError("质量门禁需要 1 到 20 条检查命令")
        # Run change-hygiene checks before business build commands.
        # Invalid locks, generated files, and oversized additions can fail without a full build.
        # Include hygiene results in checks and use the ordinary quality-failure recovery path.
        # Return actionable file-level feedback to implementation.
        # Older Runners ignore the new hygiene configuration for rolling-upgrade compatibility.
        if spec.get("hygiene"):
            from . import change_hygiene
            target_ref = "origin/" + str(
                dict(spec.get("repository") or {}).get("target") or "")
            started = time.time()
            _append(run_id, "\n[改动卫生] 检查分支相对 %s 的新增与锁文件…" % target_ref)
            hygiene = change_hygiene.check_branch(repo_dir, target_ref)
            detail = ("通过" if hygiene["ok"] else
                      "\n- " + "\n- ".join(hygiene["problems"]))
            _append(run_id, detail)
            check = {"name": "改动卫生", "ok": bool(hygiene["ok"]), "exitCode": 0,
                     "durationMs": int((time.time() - started) * 1000),
                     "detail": detail[-2000:]}
            checks.append(check)
            state["result"] = {"checks": checks, "commit": commit}
            _save(state)
            if not check["ok"]:
                raise RuntimeError("改动卫生未通过")
        env = dict(os.environ)
        env["CI"] = "1"
        for index, raw in enumerate(commands):
            item = dict(raw or {})
            name = str(item.get("name") or f"检查 {index + 1}")[:100]
            cwd = _command_dir(repo_dir, item.get("workingDir"))
            timeout = min(1800, max(5, int(item.get("timeoutSeconds") or 300)))
            argv = _argv(item.get("argv"))
            produced = (_project_selftest(run_id, cwd, env, timeout)
                        if argv == ["project:selftest"]
                        else [_run_argv(run_id, name, argv, cwd, env, timeout)])
            for check in produced:
                checks.append(check)
                state["result"] = {"checks": checks, "commit": commit}
                _save(state)
                if not check["ok"]:
                    raise RuntimeError(f"{check['name']}未通过")
        state.update(state="succeeded", result={"checks": checks, "commit": commit})
    except Exception as e:  # noqa: BLE001
        failure_kind = getattr(e, "failure_kind", "") or _failure_kind(str(e), checks)
        state.update(
            state="failed", error=str(e)[:1000],
            result={"checks": checks, **({"commit": commit} if commit else {})},
            failureKind=failure_kind,
            failurePath=("runner" if failure_kind == "infrastructure"
                         else "configuration" if failure_kind == "configuration" else "quality"))
    finally:
        _drop_checkout(mirror, checkout)
        state["finishedAt"] = int(time.time() * 1000)
        _save(state)
        with _LOCK:
            _ACTIVE.discard(run_id)


def start(spec: dict, work_root: str) -> dict:
    run_id = _id(spec.get("runId"))
    with _LOCK:
        old = _load(run_id)
        if old is not None:
            return status(run_id)
        state = {"id": run_id, "state": "queued", "createdAt": int(time.time() * 1000),
                 "startedAt": None, "finishedAt": None, "error": "", "result": {}}
        _save(state)
        _ACTIVE.add(run_id)
    threading.Thread(target=_worker, args=(dict(spec), work_root),
                     name="quality-" + run_id[:8], daemon=True).start()
    return {"ok": True, **state}


def status(run_id: str) -> dict:
    state = _load(run_id)
    if state is None:
        return {"ok": False, "error": "质量运行不存在"}
    try:
        with open(_log_path(run_id), encoding="utf-8", errors="replace") as f:
            log = f.read()[-12000:]
    except OSError:
        log = ""
    return {"ok": True, **state, "log": log}


def busy() -> int:
    with _LOCK:
        return len(_ACTIVE)
