"""Platform-correct DeepSeek Harness runtime managed by SoduWork.

The ACP adapter ships a version-locked DSH archive. That archive can be
produced on another platform, so npm can omit optional native packages. SoduWork
extracts the verified archive into a staging directory, downloads only the
exact native packages recorded in its lock file, verifies their hashes,
and atomically activates the complete runtime through DSH_PATH.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import queue
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path, PurePosixPath


PACKAGE = "@deepseek-ai/dsh"
_HOST_PARTS = ("agent-runtimes", "dsh-host")
_MARKER = ".soduwork-dsh-runtime.json"
_BOOT_CACHE: dict[tuple, tuple[float, str]] = {}
_BOOT_LOCK = threading.Lock()
_BOOT_CACHE_SECONDS = 300.0


def default_data_root() -> str:
    explicit = str(os.environ.get("SODUWORK_DATA_ROOT") or "").strip()
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    home = os.path.expanduser("~")
    if os.name == "nt":
        return os.path.join(
            os.environ.get("LOCALAPPDATA") or os.path.join(home, ".soduwork"),
            "soduwork",
        )
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "soduwork")
    return os.path.join(
        os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"),
        "soduwork",
    )


def host_root(data_root: str | None = None) -> str:
    return os.path.join(
        os.path.abspath(os.path.expanduser(data_root or default_data_root())),
        *_HOST_PARTS,
    )


def _package_file(root: str, package: str) -> str:
    return os.path.join(root, "node_modules", *package.split("/"), "package.json")


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _adapter_candidates(executable: str = "", npm_root: str = "") -> list[str]:
    candidates: list[str] = []
    explicit = str(os.environ.get("SODUWORK_DSH_ACP_MANIFEST") or "").strip()
    if explicit:
        return [os.path.abspath(os.path.expanduser(explicit))]
    if executable:
        from .agent_installation import selected_manifest
        selected = selected_manifest('@openma/deepseek-harness-acp', executable)
        return [selected] if selected else []
    if npm_root:
        candidates.append(os.path.join(
            npm_root, "@openma", "deepseek-harness-acp", "package.json"))
    appdata = str(os.environ.get("APPDATA") or "")
    if appdata:
        candidates.append(os.path.join(
            appdata, "npm", "node_modules", "@openma",
            "deepseek-harness-acp", "package.json"))
    for prefix in ("/usr/local/lib/node_modules", "/usr/lib/node_modules"):
        candidates.append(os.path.join(
            prefix, "@openma", "deepseek-harness-acp", "package.json"))
    return list(dict.fromkeys(candidates))


def adapter_runtime_bundle(executable: str = "", npm_root: str = "",
                           manifest_path: str = "") -> dict:
    """Locate the adapter's immutable runtime archive and metadata."""
    candidates = ([manifest_path] if manifest_path else
                  _adapter_candidates(executable, npm_root))
    for path in candidates:
        manifest = _read_json(path)
        expected = str((manifest.get("dshAcp") or {}).get(
            "standaloneDsh") or "").strip()
        if not expected:
            continue
        vendor = os.path.join(os.path.dirname(path), "vendor")
        metadata = _read_json(os.path.join(vendor, "runtime.json"))
        archive_name = str(metadata.get("archive") or "").strip()
        version = str(metadata.get("dsh") or "").strip()
        digest = str(metadata.get("sha256") or "").strip().lower()
        vendor = os.path.abspath(vendor)
        archive = os.path.abspath(os.path.join(vendor, archive_name))
        try:
            inside_vendor = os.path.commonpath((vendor, archive)) == vendor
        except ValueError:
            inside_vendor = False
        if (not archive_name or not inside_vendor or version != expected or
                len(digest) != 64 or not os.path.isfile(archive)):
            continue
        return {
            "manifest": os.path.abspath(path), "archive": archive,
            "version": version, "sha256": digest,
        }
    return {}


def adapter_expected_version(
        executable: str = "", npm_root: str = "", manifest_path: str = "") -> str:
    bundle = adapter_runtime_bundle(executable, npm_root, manifest_path)
    if bundle:
        return str(bundle["version"])
    candidates = ([manifest_path] if manifest_path else
                  _adapter_candidates(executable, npm_root))
    for path in candidates:
        value = str((_read_json(path).get("dshAcp") or {}).get(
            "standaloneDsh") or "").strip()
        if value:
            return value
    return ""


def _installed_version_at(root: str) -> str:
    return str(_read_json(_package_file(root, PACKAGE)).get("version") or "").strip()


def installed_version(data_root: str | None = None) -> str:
    return _installed_version_at(host_root(data_root))


def _arch() -> str:
    machine = platform.machine().lower()
    if machine in ("amd64", "x86_64", "x64"):
        return "x64"
    if machine in ("arm64", "aarch64"):
        return "arm64"
    return ""


def _linux_libc() -> str:
    name = platform.libc_ver()[0].lower()
    if name in ("glibc", "musl"):
        return name
    try:
        if os.confstr("CS_GNU_LIBC_VERSION"):
            return "glibc"
    except (AttributeError, OSError, ValueError):
        pass
    if list(Path("/lib").glob("ld-musl-*.so.1")):
        return "musl"
    raise RuntimeError("无法识别 Linux libc，不能验证 DeepSeek Harness 原生组件")


def _native_target(executable: str = "") -> tuple[str, str, str]:
    # The standalone host is imported into the adapter's Node process. Python
    # can have a different architecture (Rosetta) or Linux libc from that Node.
    from . import acp_agents, agent_npm_runtime
    selected = executable or acp_agents.find_bin('dsh') or ''
    command = acp_agents.executable_command('dsh', selected) if selected else []
    if len(command) > 1:
        node = command[0]
        try:
            identity = json.loads(agent_npm_runtime._probe(
                (node, '-p', agent_npm_runtime._NODE_IDENTITY), (agent_npm_runtime._stamp(node),)))
        except (TypeError, ValueError):
            identity = {}
        if not isinstance(identity, dict):
            identity = {}
        system, arch, libc = (str(identity.get(key) or '') for key in ('platform', 'arch', 'libc'))
        if (not identity.get('node') or identity.get('electron') or system != sys.platform
                or system not in {'win32', 'darwin', 'linux'} or arch not in {'x64', 'arm64'}):
            raise RuntimeError('无法确认 DeepSeek Harness 所选 Node 的平台和架构')
        if system == 'linux' and libc not in {'glibc', 'musl'}:
            raise RuntimeError('无法确认 DeepSeek Harness 所选 Node 的 Linux libc')
        return system, arch, libc if system == 'linux' else ''
    # Preserve the legacy native/custom wrapper path; do not reinterpret it as JS.
    system, arch = sys.platform, _arch()
    if system not in ("win32", "darwin", "linux") or not arch:
        raise RuntimeError("当前平台或 CPU 架构尚不受 DeepSeek Harness 支持")
    return system, arch, _linux_libc() if system == "linux" else ""


def _required_native_packages(target=None) -> tuple[str, ...]:
    system, arch, libc = target or _native_target()
    sharp_system = "linuxmusl" if libc == "musl" else system
    names = (f"@img/sharp-{sharp_system}-{arch}",
             f"@koromix/koffi-{system}-{arch}",
             f"@vscode/ripgrep-{system}-{arch}")
    # Verified adapter 0.4.41: Windows bundles libvips inside sharp; Darwin
    # and both Linux libc variants require a separate locked libvips package.
    if system != "win32":
        names += (f"@img/sharp-libvips-{sharp_system}-{arch}",)
    return names


def _native_specs(root: str, *, target=None) -> list[dict]:
    required = _required_native_packages(target)
    owners = (("sharp", required[0]), ("koffi", required[1]),
              ("@vscode/ripgrep", required[2]))
    if len(required) == 4:
        owners += (("sharp", required[3]),)
    lock_packages = (_read_json(os.path.join(root, "package-lock.json")).get(
        "packages") or {})
    specs = []
    for owner, package in owners:
        owner_data = _read_json(_package_file(root, owner))
        version = str((owner_data.get("optionalDependencies") or {}).get(
            package) or "").strip()
        lock = lock_packages.get("node_modules/" + package) or {}
        locked = str(lock.get("version") or "").strip()
        integrity = str(lock.get("integrity") or "").strip()
        if not version or locked != version or not integrity.startswith("sha512-"):
            raise RuntimeError(
                f"内置运行时没有锁定 {package} 的完整版本与校验值")
        specs.append({"name": package, "version": version,
                      "integrity": integrity})
    return specs


def _native_files(root: str, package: str, version: str, *, native_target=None) -> list[str]:
    """Critical loaders/binaries in the reviewed archive, not arbitrary globs."""
    folder = os.path.dirname(_package_file(root, package))
    if package.startswith("@vscode/ripgrep-"):
        relative = ["bin/rg.exe" if "-win32-" in package else "bin/rg"]
    elif package.startswith("@koromix/koffi-"):
        target = package.removeprefix("@koromix/koffi-").replace("-", "_")
        if target.startswith("linux_") and (native_target or _native_target())[2] == "musl":
            target = target.replace("linux_", "musl_", 1)
        relative = ["index.js", target + "/koffi.node"]
    elif package.startswith("@img/sharp-libvips-"):
        exported = (_read_json(os.path.join(folder, "package.json")).get("exports") or {})
        if not isinstance(exported, dict):
            exported = {}
        relative = ["lib/index.js", str(exported.get("./binary") or ".missing-binary")]
    else:
        target = package.removeprefix("@img/sharp-")
        relative = ["index.cjs", f"lib/sharp-{target}-{version}.node"]
        if target.startswith("win32-"):
            vips = str(_read_json(os.path.join(folder, "versions.json")).get("vips") or "")
            relative += ["lib/libvips-42.dll", f"lib/libvips-cpp-{vips}.dll"]
    paths = []
    for name in relative:
        path = os.path.abspath(os.path.join(folder, name))
        if os.path.commonpath((os.path.abspath(folder), path)) != os.path.abspath(folder):
            raise RuntimeError(f"{package} 的原生组件路径无效")
        paths.append(path)
    return paths


def _has_exact_package(root: str, package: str, version: str, *, target=None) -> bool:
    manifest = _read_json(_package_file(root, package))
    if manifest.get("name") != package or manifest.get("version") != version:
        return False
    try:
        paths = _native_files(root, package, version, native_target=target)
        return all(os.path.isfile(path) and os.path.getsize(path) > 0 for path in paths)
    except (OSError, ValueError, RuntimeError):
        return False


def _runtime_issue_at(root: str, expected_version: str = "", *, executable: str = "", target=None) -> str:
    version = _installed_version_at(root)
    if not version:
        return ("DeepSeek Harness 适配器已安装，但 SoduWork 执行运行时尚未准备好。"
                "请在 Agent 管理的 DeepSeek Harness 卡片上点「修复安装」后重试。")
    if expected_version and version != expected_version:
        return ("DeepSeek Harness 执行运行时版本不匹配：当前 %s，需要 %s。"
                "请在 Agent 管理的 DeepSeek Harness 卡片上点「修复安装」。" %
                (version, expected_version))
    try:
        target = target or _native_target(executable)
        specs = _native_specs(root, target=target)
    except RuntimeError as exc:
        return "DeepSeek Harness 运行时清单不完整：" + str(exc)
    missing = [f"{spec['name']}@{spec['version']}" for spec in specs
               if not _has_exact_package(root, spec["name"], spec["version"], target=target)]
    if missing:
        return ("DeepSeek Harness 的当前平台原生组件不完整（缺少或损坏 %s）。"
                "请在 Agent 管理的 DeepSeek Harness 卡片上点「修复安装」后重试。" %
                "、".join(missing))
    return ""


def runtime_issue(data_root: str | None = None, expected_version: str = "", *, executable: str = "") -> str:
    return _runtime_issue_at(host_root(data_root), expected_version, executable=executable)


def _storage_env(env: dict, runtime_root: str) -> None:
    if os.name != "nt":
        return
    loader = Path(__file__).with_name("dsh_session_storage.mjs")
    if not loader.is_file():
        raise RuntimeError("DeepSeek Harness 存储兼容组件缺失，请更新 SoduWork")
    env["SODUWORK_DSH_STORAGE_RUNTIME"] = runtime_root
    env["NODE_OPTIONS"] = "--import=" + loader.resolve().as_uri()


def _host_env(env: dict, runtime_root: str) -> None:
    # Only host-owned preloads may alter the native adapter. Repeated setup must
    # not duplicate hooks or inherit arbitrary shell/desktop Node options.
    env.pop("NODE_OPTIONS", None)
    _storage_env(env, runtime_root)
    loader = Path(__file__).with_name("dsh_acp_settlement.mjs")
    if not loader.is_file():
        raise RuntimeError("DeepSeek Harness 子代理等待组件缺失，请更新 SoduWork")
    env["SODUWORK_DSH_ACP_SETTLEMENT"] = "1"
    env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") +
                           " --import=" + loader.resolve().as_uri()).strip()


def apply_env(env: dict, data_root: str | None = None) -> None:
    env["DSH_PATH"] = host_root(data_root)
    _host_env(env, env["DSH_PATH"])
    env.setdefault("DSH_TELEMETRY_DISABLED", "1")


def apply_access_env(env: dict, policy: dict | None) -> None:
    """Start the native host at the trusted policy, before session creation.

    The ACP bridge still verifies the advertised mode and waits for its ACK.
    Never inherit a wider permission default from the parent shell or profile.
    Legacy requests without the versioned policy keep their native defaults.
    """
    if policy is None:
        return
    modes = {"standard": "workspace-write", "readonly": "read-only",
             "full": "danger-full-access"}
    native = modes.get(str(policy.get("mode") or ""))
    if not native:
        raise RuntimeError("DeepSeek Harness 收到无效权限模式")
    env["DSH_PERMISSION_MODE"] = native


def prepare_temp(env: dict, data_root: str, ref: str = "", workspace: str = "") -> str:
    """Keep DSH's per-session runtime temp outside its sandbox workspace.

    The Windows ACL backend assigns different write grants to the workspace
    and temp root and explicitly rejects overlapping roots. Do not weaken its
    sandbox mode or substitute the whole user's system temp directory.
    """
    identity = str(ref or workspace or "shared")
    folder = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
    target = os.path.join(os.path.abspath(os.path.expanduser(data_root)),
                          "agents", "dsh", folder, "temp")
    if workspace:
        work = os.path.normcase(os.path.realpath(os.path.expanduser(workspace)))
        temp = os.path.normcase(os.path.realpath(target))
        try:
            overlap = os.path.commonpath((work, temp)) in (work, temp)
        except ValueError:  # Separate Windows drives cannot overlap.
            overlap = False
        if overlap:
            raise RuntimeError("DeepSeek Harness 运行时临时目录必须与工作目录隔离，请调整工作目录或 Runner 数据目录")
    os.makedirs(target, mode=0o700, exist_ok=True)
    env["TEMP"] = env["TMP"] = env["TMPDIR"] = target
    return target


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _member_parts(name: str, strip_prefix: str = "") -> tuple[str, ...]:
    normalized = str(name or "").replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if (not normalized or normalized.startswith("/") or "\x00" in normalized or
            (len(normalized) > 1 and normalized[1] == ":")):
        raise RuntimeError("运行时归档包含不安全路径：" + str(name)[:180])
    parts = tuple(PurePosixPath(normalized).parts)
    if strip_prefix:
        if not parts or parts[0] != strip_prefix:
            return ()
        parts = parts[1:]
    if any(part in ("", ".", "..") for part in parts):
        raise RuntimeError("运行时归档包含不安全路径：" + str(name)[:180])
    return parts


def _io_path(path: str) -> str:
    """Use Windows extended paths for deep package trees, without changing identity."""
    if os.name != "nt":
        return path
    absolute = os.path.abspath(path)
    if absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def _safe_extract(archive: str, destination: str, strip_prefix: str = "") -> None:
    root = os.path.abspath(destination)
    os.makedirs(_io_path(root), exist_ok=True)
    with tarfile.open(_io_path(archive), "r:gz") as bundle:
        for member in bundle:
            parts = _member_parts(member.name, strip_prefix)
            if not parts:
                continue
            target = os.path.abspath(os.path.join(root, *parts))
            if os.path.commonpath((root, target)) != root:
                raise RuntimeError("运行时归档试图写出目标目录")
            # Validate the ordinary path first; only filesystem calls use the prefix.
            target = _io_path(target)
            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            if not member.isfile():
                # Skip npm .bin links, which are unnecessary for DSH loading and could escape the archive root.
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                raise RuntimeError("无法读取运行时归档成员：" + member.name)
            with source, open(target, "wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            if os.name != "nt":
                os.chmod(target, member.mode & 0o777)


def stage_bundled_runtime(data_root: str, executable: str = "",
                          npm_root: str = "") -> dict:
    """Extract a verified adapter runtime without touching the active host."""
    bundle = adapter_runtime_bundle(executable, npm_root)
    if not bundle:
        raise RuntimeError("无法读取 DeepSeek Harness 适配器内置运行时")
    if _sha256(bundle["archive"]) != bundle["sha256"]:
        raise RuntimeError("DeepSeek Harness 内置运行时完整性校验失败")
    parent = os.path.dirname(host_root(data_root))
    os.makedirs(parent, exist_ok=True)
    stage = tempfile.mkdtemp(prefix=".dsh-host-stage-", dir=parent)
    try:
        _safe_extract(bundle["archive"], stage)
        version = _installed_version_at(stage)
        if version != bundle["version"]:
            raise RuntimeError(
                f"内置运行时版本不一致：归档 {version or '未知'}，"
                f"清单 {bundle['version']}")
        specs = _native_specs(stage, target=_native_target(executable))
        return {"path": stage, "version": version, "sha256": bundle["sha256"],
                "nativePackages": specs}
    except Exception:
        shutil.rmtree(_io_path(stage), ignore_errors=True)
        raise


def _stage_parent(stage: str) -> str:
    root = os.path.abspath(stage)
    name = os.path.basename(root)
    if not name.startswith(".dsh-host-stage-"):
        raise RuntimeError("拒绝操作非 SoduWork DSH 临时目录")
    return root


def native_pack_dir(stage: str, spec: dict) -> str:
    root = _stage_parent(stage)
    slug = str(spec.get("name") or "").replace("@", "").replace("/", "-")
    destination = os.path.join(root, ".soduwork-native-packs", slug)
    os.makedirs(destination, exist_ok=True)
    return destination


def native_pack_argv(npm: str, stage: str, spec: dict) -> list[str]:
    name = str(spec.get("name") or "")
    version = str(spec.get("version") or "")
    if not (npm and name and version):
        return []
    return [npm, "pack", "--json", "--ignore-scripts", "--pack-destination",
            native_pack_dir(stage, spec), f"{name}@{version}"]


def _verify_integrity(path: str, expected: str) -> None:
    algorithm, separator, encoded = str(expected or "").partition("-")
    if separator != "-" or algorithm.lower() != "sha512":
        raise RuntimeError("原生包缺少可用的 SHA-512 校验值")
    digest = hashlib.sha512()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = base64.b64encode(digest.digest()).decode("ascii")
    if actual != encoded:
        raise RuntimeError("下载的原生包完整性校验失败")


def install_native_pack(stage: str, spec: dict) -> None:
    """Verify and unpack one npm tarball without running package scripts."""
    root = _stage_parent(stage)
    pack_dir = native_pack_dir(root, spec)
    archives = list(Path(pack_dir).glob("*.tgz"))
    if len(archives) != 1:
        raise RuntimeError("没有拿到唯一的原生组件安装包")
    archive = str(archives[0])
    _verify_integrity(archive, str(spec.get("integrity") or ""))
    package = str(spec.get("name") or "")
    version = str(spec.get("version") or "")
    parent = os.path.join(root, "node_modules", *package.split("/")[:-1])
    target = os.path.join(root, "node_modules", *package.split("/"))
    os.makedirs(parent, exist_ok=True)
    temporary = tempfile.mkdtemp(prefix=".native-stage-", dir=parent)
    try:
        _safe_extract(archive, temporary, strip_prefix="package")
        manifest = _read_json(os.path.join(temporary, "package.json"))
        if (str(manifest.get("name") or "") != package or
                str(manifest.get("version") or "") != version):
            raise RuntimeError("原生组件包名或版本与锁文件不一致")
        if os.path.isdir(target):
            shutil.rmtree(_io_path(target))
        os.replace(temporary, target)
        temporary = ""
    finally:
        if temporary:
            shutil.rmtree(_io_path(temporary), ignore_errors=True)
        shutil.rmtree(_io_path(pack_dir), ignore_errors=True)


def activate_stage(stage: str, data_root: str, expected_version: str,
                   archive_sha256: str = "", *, executable: str = "") -> None:
    """Atomically replace the active host only after full static validation."""
    staged = _stage_parent(stage)
    target_identity = _native_target(executable)
    issue = _runtime_issue_at(staged, expected_version, target=target_identity)
    if issue:
        raise RuntimeError(issue)
    packs = os.path.join(staged, ".soduwork-native-packs")
    shutil.rmtree(_io_path(packs), ignore_errors=True)
    with open(os.path.join(staged, _MARKER), "w", encoding="utf-8") as handle:
        json.dump({"version": expected_version, "archiveSha256": archive_sha256,
                   "nativePackages": _native_specs(staged, target=target_identity)}, handle,
                  ensure_ascii=False, indent=2)
    target = os.path.abspath(host_root(data_root))
    parent = os.path.dirname(target)
    if os.path.dirname(staged) != parent:
        raise RuntimeError("DSH 临时目录与目标目录不在同一位置")
    backup = tempfile.mkdtemp(prefix=".dsh-host-backup-", dir=parent)
    os.rmdir(backup)
    had_target = os.path.isdir(target)
    activated = False
    try:
        if had_target:
            os.replace(target, backup)
        os.replace(staged, target)
        activated = True
    except Exception:
        if had_target and os.path.isdir(backup) and not os.path.exists(target):
            os.replace(backup, target)
        raise
    finally:
        if activated and os.path.isdir(backup):
            shutil.rmtree(_io_path(backup), ignore_errors=True)
    with _BOOT_LOCK:
        _BOOT_CACHE.clear()


def discard_stage(stage: str) -> None:
    if not stage:
        return
    try:
        root = _stage_parent(stage)
    except RuntimeError:
        return
    shutil.rmtree(_io_path(root), ignore_errors=True)


def remove_host(data_root: str | None = None) -> None:
    parent = os.path.abspath(os.path.join(
        os.path.abspath(os.path.expanduser(data_root or default_data_root())),
        _HOST_PARTS[0],
    ))
    target = os.path.abspath(host_root(data_root))
    if os.path.commonpath((parent, target)) != parent or target == parent:
        raise RuntimeError("refusing to remove an unsafe DSH runtime path")
    if os.path.isdir(target):
        shutil.rmtree(_io_path(target))
    with _BOOT_LOCK:
        _BOOT_CACHE.clear()

def _fingerprint(executable: str, data_root: str, expected_version: str) -> tuple:
    root = host_root(data_root)
    paths = [executable, _package_file(root, PACKAGE),
             os.path.join(root, "package-lock.json")]
    from .acp_agents import executable_command
    try:
        paths.extend(executable_command('dsh', executable))
    except RuntimeError:
        # No longer having a compatible Node invalidates the successful identity;
        # the actual probe returns the actionable startup failure.
        pass
    paths += [_package_file(root, name) for name in ("sharp", "koffi", "@vscode/ripgrep")]
    try:
        target_identity = _native_target(executable)
        specs = _native_specs(root, target=target_identity)
    except RuntimeError:
        specs = []
    for spec in specs:
        paths.append(_package_file(root, spec["name"]))
        paths.extend(_native_files(root, spec["name"], spec["version"], native_target=target_identity))
    mtimes = []
    for path in paths:
        try:
            stat = os.stat(path)
            mtimes.append((path, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size, stat.st_mode))
        except OSError:
            mtimes.append((path, 0.0))
    return (os.path.abspath(executable), root, expected_version, tuple(mtimes))


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
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


def _failure_detail(output: str, code: int | None) -> str:
    low = str(output or "").lower()
    if "sharp" in low or "koffi" in low or "plugin tree failed to load" in low:
        return ("DeepSeek Harness 启动自检失败：当前平台原生组件未正确加载。"
                "请在 Agent 管理中打开 DeepSeek Harness 详情，点「重装 / 升到最新」修复。")
    lines = [line.strip() for line in str(output or "").splitlines() if line.strip()]
    tail = "；".join(lines[-3:])[:360]
    suffix = ("：" + tail) if tail else ("（退出码 %s）" % code)
    return "DeepSeek Harness 启动自检失败" + suffix


def _probe_runtime(executable: str, runtime_root: str,
                   probe_root: str, timeout: int) -> str:
    """Verify the staged ACP server with a protocol handshake.

    The adapter is a long-lived stdio service. Waiting for it to exit marks a
    healthy server as a timeout, so the probe must exercise the same
    initialize request used by the real bridge.
    """
    os.makedirs(probe_root, exist_ok=True)
    proc = None
    probe_id = "soduwork-dsh-runtime-probe"
    events: queue.Queue[tuple[str, str | None]] = queue.Queue()
    readers: list[threading.Thread] = []

    def read_lines(source: str, stream) -> None:
        try:
            for line in iter(stream.readline, ""):
                events.put((source, line))
        finally:
            events.put((source, None))

    try:
        with tempfile.TemporaryDirectory(prefix="dsh-", dir=probe_root) as home:
            env = dict(os.environ)
            for name in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"):
                env.pop(name, None)
            env["DSH_PATH"] = runtime_root
            _host_env(env, runtime_root)
            env.setdefault("DSH_TELEMETRY_DISABLED", "1")
            env.update(
                DSH_HOME=home,
                DEEPSEEK_API_KEY="soduwork-runtime-probe",
                DEEPSEEK_BASE_URL="http://127.0.0.1:9/v1",
                DSH_PROVIDER="deepseek-official",
                DSH_MODEL="soduwork-runtime-probe",
                NO_PROXY="127.0.0.1,localhost",
            )
            kwargs = ({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
                      if os.name == "nt" else {"start_new_session": True})
            from .acp_agents import executable_command
            from .agent_installation import prepend_node_path
            command = executable_command('dsh', executable)
            if len(command) > 1:
                prepend_node_path(env, command[0])
            proc = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, cwd=runtime_root, env=env,
                text=True, encoding="utf-8", errors="replace", **kwargs,
            )
            assert proc.stdin is not None and proc.stdout is not None
            assert proc.stderr is not None
            for source, stream in (("stdout", proc.stdout), ("stderr", proc.stderr)):
                thread = threading.Thread(
                    target=read_lines, args=(source, stream), daemon=True)
                thread.start()
                readers.append(thread)

            packet = {
                "jsonrpc": "2.0", "id": probe_id, "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "auth": {"_meta": {"gateway": True}},
                        "fs": {"readTextFile": True, "writeTextFile": False},
                        "terminal": False,
                    },
                    "clientInfo": {
                        "name": "soduwork-runtime-probe",
                        "title": "SoduWork Runtime Probe", "version": "1",
                    },
                },
            }
            proc.stdin.write(json.dumps(packet, ensure_ascii=False) + "\n")
            proc.stdin.flush()

            deadline = time.monotonic() + max(0.1, float(timeout))
            closed: set[str] = set()
            stdout_lines: list[str] = []
            stderr_lines: list[str] = []
            while time.monotonic() < deadline:
                remaining = max(0.01, deadline - time.monotonic())
                try:
                    source, line = events.get(timeout=min(0.25, remaining))
                except queue.Empty:
                    continue
                if line is None:
                    closed.add(source)
                    if proc.poll() is not None and len(closed) == 2:
                        output = "\n".join(stderr_lines + stdout_lines)
                        return _failure_detail(output, proc.returncode)
                    continue
                if source == "stderr":
                    stderr_lines.append(line.rstrip())
                    continue
                stdout_lines.append(line.rstrip())
                try:
                    message = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if not isinstance(message, dict) or message.get("id") != probe_id:
                    continue
                if message.get("error"):
                    error = message.get("error")
                    detail = (error.get("message") if isinstance(error, dict)
                              else str(error))
                    output = "\n".join(stderr_lines + [str(detail or error)])
                    return _failure_detail(output, proc.poll())
                payload = message.get("result")
                info = payload.get("agentInfo") if isinstance(payload, dict) else None
                if (not isinstance(payload, dict)
                        or payload.get("protocolVersion") != 1
                        or not isinstance(info, dict) or not info.get("name")):
                    return ("DeepSeek Harness 启动自检失败：ACP initialize "
                            "返回内容不完整，请在 Agent 管理的详情中点「重装 / 升到最新」后重试。")
                return ""

            output = "\n".join(stderr_lines + stdout_lines)
            if proc.poll() is not None:
                return _failure_detail(output, proc.returncode)
            return ("DeepSeek Harness 启动自检超时，已安全停止。"
                    "请在 Agent 管理的详情中点「重装 / 升到最新」后重试。")
    except Exception as exc:  # noqa: BLE001
        return "DeepSeek Harness 启动自检失败：" + str(exc)[:300]
    finally:
        if proc is not None:
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            _kill_tree(proc)
        for thread in readers:
            thread.join(timeout=0.2)
def stage_boot_issue(executable: str, stage: str, expected_version: str,
                     *, timeout: int = 15) -> str:
    """Boot the staged tree before it is allowed to replace the active host."""
    try:
        runtime_root = _stage_parent(stage)
    except RuntimeError as exc:
        return str(exc)
    issue = _runtime_issue_at(runtime_root, expected_version, executable=executable)
    if issue:
        return issue
    if not executable or not os.path.isfile(executable):
        return "DeepSeek Harness 可执行文件不存在，请重新安装。"
    probe_root = os.path.join(os.path.dirname(runtime_root), ".probe")
    return _probe_runtime(executable, runtime_root, probe_root, timeout)


def boot_issue(executable: str, data_root: str | None = None,
               expected_version: str = "", *, timeout: int = 15,
               force: bool = False) -> str:
    root = os.path.abspath(os.path.expanduser(data_root or default_data_root()))
    issue = runtime_issue(root, expected_version, executable=executable)
    if issue:
        return issue
    if not executable or not os.path.isfile(executable):
        return "DeepSeek Harness 可执行文件不存在，请重新安装。"
    fingerprint = _fingerprint(executable, root, expected_version)
    now = time.monotonic()
    with _BOOT_LOCK:
        cached = _BOOT_CACHE.get(fingerprint)
        if cached and not force and now - cached[0] < _BOOT_CACHE_SECONDS:
            return cached[1]
    result = _probe_runtime(
        executable, host_root(root),
        os.path.join(root, "agent-runtimes", ".probe"), timeout)
    with _BOOT_LOCK:
        _BOOT_CACHE[fingerprint] = (time.monotonic(), result)
    return result


__all__ = [
    "PACKAGE", "activate_stage", "adapter_expected_version", "apply_access_env",
    "adapter_runtime_bundle", "apply_env", "boot_issue", "default_data_root",
    "discard_stage", "host_root", "install_native_pack", "installed_version",
    "native_pack_argv", "prepare_temp", "remove_host", "runtime_issue",
    "stage_boot_issue", "stage_bundled_runtime",
]
