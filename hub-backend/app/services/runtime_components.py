"""Runner-managed capability components installed under its data root. Stage downloads, verify
source integrity and a minimal real task, then atomically switch active.json. Retain previous
versions so failed upgrades cannot destroy the working installation; Hub selects only reviewed
component keys.
"""
from __future__ import annotations

import json
import logging
import os
import platform
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from .local_base import _data_root


log = logging.getLogger("uvicorn.error")
SCHEMA_VERSION = 1
_SAFE_KEY = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_SAFE_VERSION = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")
_LOG_CAP = 300

# This is a reviewed release manifest, not a live marketplace; fingerprints change with product releases.
CATALOG: dict[str, dict] = {
    "office": {
        "key": "office", "label": "开源办公文档适配器", "kind": "npm",
        "package": "@officecli/officecli", "version": "1.0.143",
        "integrity": "sha512-6fNynmrNso9wiRf2mIs6magdFHKQbsQC6u5qsZtwWwgZrc/kNr5++Wajp220sBnFPPuRiuKx1xy8LW+I2MZEbw==",
        "repository": "git+https://github.com/iOfficeAI/OfficeCLI.git",
        "license": "Apache-2.0", "command": "officecli",
        "summary": "可选的 Apache-2.0 本地适配器；不使用托管额度，也不随客户端强制安装。",
        "installable": True,
    },
    "browser": {
        "key": "browser", "label": "浏览与检索", "kind": "prerequisite",
        "summary": "使用 SoduWork 内置浏览器桥接；需要 Node 22+ 与 Chrome/Edge。",
        "installable": False,
    },
    "computer": {
        "key": "computer", "label": "操作电脑", "kind": "bundled",
        "summary": "随 Windows 客户端提供，仅需机器所有者在本机授权。",
        "installable": False,
    },
}

_JOBS: dict[str, dict] = {}
_JOB_LOCK = threading.RLock()
_JOB_THREADS: set[threading.Thread] = set()
_ACTIVE_PATHS: set[str] = set()


def _root() -> Path:
    return Path(_data_root()) / "components"


def _active_file() -> Path:
    return _root() / "active.json"


def _component_dir(key: str, version: str) -> Path:
    if not _SAFE_KEY.fullmatch(str(key or "")) or not _SAFE_VERSION.fullmatch(str(version or "")):
        raise ValueError("组件名称或版本不合法")
    return _root() / key / version


def _load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".next-" + uuid.uuid4().hex[:8])
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _active() -> dict[str, str]:
    raw = _load_json(_active_file()).get("components") or {}
    out: dict[str, str] = {}
    if isinstance(raw, dict):
        for key, version in raw.items():
            key, version = str(key or ""), str(version or "")
            if _SAFE_KEY.fullmatch(key) and _SAFE_VERSION.fullmatch(version):
                out[key] = version
    return out


def _package_dir(root: Path, spec: dict) -> Path:
    scope, name = str(spec["package"]).split("/", 1)
    return root / "node_modules" / scope / name


def _native_command(root: Path, spec: dict) -> Path:
    name = "officecli.exe" if os.name == "nt" else "officecli"
    return _package_dir(root, spec) / "vendor" / name


def _shim_command(root: Path, spec: dict) -> Path:
    suffix = ".cmd" if os.name == "nt" else ""
    return root / "node_modules" / ".bin" / (str(spec["command"]) + suffix)


def _package_version(root: Path, spec: dict) -> str:
    return str(_load_json(_package_dir(root, spec) / "package.json").get("version") or "")


def _probe(root: Path, spec: dict, timeout: int = 30) -> tuple[bool, str]:
    """Probe both version startup and a minimal document operation before declaring readiness."""
    command = _native_command(root, spec)
    if not command.is_file():
        command = _shim_command(root, spec)
    if not command.is_file():
        return False, "安装目录里没有找到可执行文件"
    env = dict(os.environ)
    env["OFFICECLI_SKIP_UPDATE"] = "1"
    try:
        done = subprocess.run(
            [str(command), "--version"], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
            text=True, encoding="utf-8", errors="replace", timeout=timeout,
            check=False,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        )
        text = str(done.stdout or "").strip()
        first = (text.splitlines() or [""])[0][:160]
        if done.returncode != 0 or not first:
            return False, first or "命令没有返回版本"
        # An npm shim may download its native binary on first use; prefer that binary for the real probe.
        native = _native_command(root, spec)
        if native.is_file():
            command = native
        probe_dir = root / (".soduwork-probe-" + uuid.uuid4().hex[:8])
        probe_dir.mkdir(parents=True, exist_ok=False)
        document = probe_dir / "probe.docx"
        try:
            created = subprocess.run(
                [str(command), "create", str(document)], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(probe_dir),
                text=True, encoding="utf-8", errors="replace", timeout=max(30, timeout),
                check=False,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
            header = document.read_bytes()[:2] if document.is_file() else b""
            if created.returncode != 0 or header != b"PK":
                reason = (str(created.stdout or "").strip().splitlines() or
                          ["没有生成有效的 Word 文件"])[0][:160]
                return False, "最小文档探活失败：" + reason
        finally:
            shutil.rmtree(probe_dir, ignore_errors=True)
        return True, first
    except Exception as exc:  # noqa: BLE001
        return False, "%s: %s" % (type(exc).__name__, str(exc)[:120])


def _activation_dirs(key: str, version: str) -> list[Path]:
    spec = CATALOG.get(key) or {}
    root = _component_dir(key, version)
    if spec.get("kind") != "npm" or not root.is_dir():
        return []
    if _package_version(root, spec) != version or not _native_command(root, spec).is_file():
        return []
    # Use native executables instead of depending on shell handling of command shims.
    return [_native_command(root, spec).parent, root / "node_modules" / ".bin"]


def activate_environment() -> dict:
    """Add activated component paths to this Runner and subsequent subprocesses."""
    global _ACTIVE_PATHS
    active = _active()
    paths: list[str] = []
    managed_office = ""
    for key, version in active.items():
        try:
            active_dirs = [p for p in _activation_dirs(key, version) if p.is_dir()]
            paths.extend(str(p) for p in active_dirs)
            if key == "office":
                spec = CATALOG.get(key) or {}
                root = _component_dir(key, version)
                command = _native_command(root, spec)
                if not command.is_file():
                    command = _shim_command(root, spec)
                if command.is_file():
                    managed_office = str(command)
        except ValueError:
            continue
    old = str(os.environ.get("PATH") or "").split(os.pathsep)
    prior = {os.path.normcase(os.path.abspath(p)) for p in _ACTIVE_PATHS if p}
    kept = [p for p in old if p and os.path.normcase(os.path.abspath(p)) not in prior]
    dedup: list[str] = []
    seen: set[str] = set()
    for item in paths + kept:
        norm = os.path.normcase(os.path.abspath(item))
        if norm not in seen:
            seen.add(norm)
            dedup.append(item)
    os.environ["PATH"] = os.pathsep.join(dedup)
    os.environ["OFFICECLI_SKIP_UPDATE"] = "1"
    if managed_office:
        os.environ["SODUWORK_MANAGED_OFFICECLI"] = managed_office
    else:
        os.environ.pop("SODUWORK_MANAGED_OFFICECLI", None)
    _ACTIVE_PATHS = set(paths)
    return {"active": active, "paths": paths}


def _npm() -> str:
    return str((shutil.which("npm.cmd") if os.name == "nt" else shutil.which("npm")) or "")


def _node() -> str:
    return str(shutil.which("node.exe" if os.name == "nt" else "node") or shutil.which("node") or "")


def status() -> dict:
    active = _active()
    items = []
    machine_supported = platform.system().lower() in {"windows", "linux", "darwin"}
    arch_supported = platform.machine().lower() in {"amd64", "x86_64", "arm64", "aarch64"}
    for key, source in CATALOG.items():
        spec = dict(source)
        version = active.get(key, "")
        installed = False
        if version and spec.get("kind") == "npm":
            try:
                installed = _package_version(_component_dir(key, version), spec) == version
            except ValueError:
                installed = False
        prerequisites = bool(_npm() and _node() and machine_supported and arch_supported)
        can_install = bool(spec.get("installable") and prerequisites)
        reason = ""
        if spec.get("installable") and not can_install:
            reason = ("需要先安装 Node.js 与 npm" if not (_npm() and _node())
                      else "当前操作系统或处理器暂不受支持")
        items.append({
            "key": key, "label": spec.get("label", key), "kind": spec.get("kind", ""),
            "summary": spec.get("summary", ""), "installable": can_install,
            "installed": installed, "activeVersion": version if installed else "",
            "targetVersion": spec.get("version", ""), "package": spec.get("package", ""),
            "license": spec.get("license", ""), "repository": spec.get("repository", ""),
            "reason": reason,
        })
    return {"schemaVersion": SCHEMA_VERSION, "items": items}


def _new_job(key: str) -> tuple[str, bool]:
    with _JOB_LOCK:
        for old in _JOBS.values():
            if old.get("key") == key and old.get("state") == "running":
                return str(old["id"]), False
        jid = uuid.uuid4().hex[:12]
        _JOBS[jid] = {
            "id": jid, "key": key, "action": "install", "state": "running",
            "ok": None, "detail": "准备安装", "lines": [], "startedAt": time.time(),
            "endedAt": None,
        }
        if len(_JOBS) > 30:
            done = sorted((x for x in _JOBS.values() if x.get("state") == "done"),
                          key=lambda x: x.get("startedAt", 0))
            for old in done[:max(0, len(_JOBS) - 30)]:
                _JOBS.pop(str(old.get("id") or ""), None)
        return jid, True


def _say(jid: str, line: str) -> None:
    clean = re.sub(r"(?:https?://)[^\s]+", "[下载地址]", str(line or ""))[:500]
    with _JOB_LOCK:
        item = _JOBS.get(jid)
        if not item:
            return
        item["lines"].append(clean)
        if len(item["lines"]) > _LOG_CAP:
            del item["lines"][:-_LOG_CAP]


def _done(jid: str, ok: bool, detail: str) -> None:
    with _JOB_LOCK:
        item = _JOBS.get(jid)
        if item:
            item.update(state="done", ok=bool(ok), detail=str(detail)[:300], endedAt=time.time())


def job(jid: str) -> dict | None:
    with _JOB_LOCK:
        item = _JOBS.get(str(jid or ""))
        return json.loads(json.dumps(item, ensure_ascii=False)) if item else None


def start_install(key: str) -> str:
    key = str(key or "").strip().lower()
    spec = CATALOG.get(key)
    if not spec or not spec.get("installable"):
        raise ValueError("这项能力不支持自动安装")
    jid, fresh = _new_job(key)
    if fresh:
        thread = threading.Thread(target=_guard_install, args=(jid, key), daemon=True)
        with _JOB_LOCK:
            _JOB_THREADS.add(thread)
        thread.start()
    return jid


def _run(jid: str, argv: list[str], timeout: int) -> tuple[int, str]:
    _say(jid, "$ " + " ".join(argv[:3]) + (" …" if len(argv) > 3 else ""))
    env = dict(os.environ)
    env["OFFICECLI_SKIP_UPDATE"] = "1"
    from .local_stream import _kill_pid_tree
    proc = subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1, env=env,
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
           else {"start_new_session": True}),
    )
    buf: list[str] = []
    timer = threading.Timer(timeout, lambda: _kill_pid_tree(proc.pid, proc))
    timer.daemon = True
    timer.start()
    started = time.monotonic()
    try:
        for line in proc.stdout or []:
            text = line.rstrip("\r\n")
            buf.append(text)
            if text.strip():
                _say(jid, text)
        try:
            proc.wait(timeout=20)
        except Exception:  # noqa: BLE001
            _kill_pid_tree(proc.pid, proc)
    finally:
        timer.cancel()
    if time.monotonic() - started >= timeout:
        _say(jid, "安装超时，已停止本轮进程")
    return int(proc.returncode if proc.returncode is not None else 1), "\n".join(buf)


def _metadata(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        return {}
    try:
        value = json.loads(text[start:end + 1])
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def _activate(key: str, version: str) -> None:
    active = _active()
    active[key] = version
    _write_json(_active_file(), {
        "schemaVersion": SCHEMA_VERSION, "components": active,
        "updatedAt": int(time.time()),
    })
    activate_environment()
    try:
        from . import execution_capabilities
        execution_capabilities.invalidate_bridge_cache()
    except Exception:  # noqa: BLE001
        pass


def _promote(staging: Path, target: Path) -> None:
    """Replace a same-version directory with rollback if the second step fails, preserving a valid
    active installation.
    """
    backup = None
    if target.exists():
        backup = target.with_name(target.name + ".replaced-" + uuid.uuid4().hex[:8])
        os.replace(target, backup)
    try:
        os.replace(staging, target)
    except Exception:
        if backup and backup.exists() and not target.exists():
            os.replace(backup, target)
        raise


def _install(jid: str, key: str) -> None:
    spec = CATALOG[key]
    npm = _npm()
    if not npm or not _node():
        _done(jid, False, "这台执行机没有 Node.js 与 npm，暂时无法安装")
        return
    version = str(spec["version"])
    package = "%s@%s" % (spec["package"], version)
    target = _component_dir(key, version)
    if target.is_dir() and _package_version(target, spec) == version:
        ok, detail = _probe(target, spec)
        if ok:
            _say(jid, "现有版本已通过探活，直接启用")
            _activate(key, version)
            _done(jid, True, "%s %s 已就绪" % (spec["label"], detail))
            return

    _say(jid, "校验受审发布清单")
    code, output = _run(jid, [npm, "view", package, "version", "dist.integrity",
                              "repository.url", "license", "--json"], 120)
    meta = _metadata(output)
    checks = {"version": version, "dist.integrity": spec["integrity"],
              "repository.url": spec["repository"], "license": spec["license"]}
    if code != 0 or any(str(meta.get(k) or "") != str(v) for k, v in checks.items()):
        _done(jid, False, "组件来源或完整性指纹与 SoduWork 发布清单不一致，已拒绝安装")
        return

    root = _root()
    root.mkdir(parents=True, exist_ok=True)
    staging = root / (".staging-%s-%s" % (key, uuid.uuid4().hex[:10]))
    try:
        _say(jid, "下载并安装到隔离目录")
        code, _ = _run(jid, [npm, "install", "--prefix", str(staging), "--no-save",
                              "--omit=dev", package], 900)
        if code != 0:
            raise RuntimeError("npm 安装失败（退出码 %d）" % code)
        if _package_version(staging, spec) != version:
            raise RuntimeError("安装后的包版本与发布清单不一致")
        ok, detail = _probe(staging, spec, 90)
        if not ok:
            raise RuntimeError("真实探活失败：" + detail)
        if not _native_command(staging, spec).is_file():
            raise RuntimeError("原生执行文件没有下载完整")
        target.parent.mkdir(parents=True, exist_ok=True)
        _promote(staging, target)
        _activate(key, version)
        _say(jid, "探活通过，已原子切换到新版本")
        _done(jid, True, "%s %s 已安装并测通" % (spec["label"], detail))
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def _guard_install(jid: str, key: str) -> None:
    try:
        _install(jid, key)
    except Exception as exc:  # noqa: BLE001
        log.exception("Runner 能力组件安装失败")
        _say(jid, "失败：%s: %s" % (type(exc).__name__, str(exc)[:180]))
        _done(jid, False, "安装失败；原来的可用版本没有改变：" + str(exc)[:180])
    finally:
        with _JOB_LOCK:
            _JOB_THREADS.discard(threading.current_thread())
            item = _JOBS.get(jid)
            if item and item.get("state") != "done":
                _done(jid, False, "安装没有正常收尾；原来的可用版本没有改变")
