"""DeepSeek Harness managed-runtime regression test; no network/model needed."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import platform
import shutil
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, ".")

from app.services import acp_agents, ai_local, dsh_runtime, local_base  # noqa: E402


VERSION = "0.1.1-rc.2"


def _manifest(path: str, value: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle)


def _native_names() -> tuple[str, ...]:
    if os.name != "nt":
        return ()
    machine = platform.machine().lower()
    arch = "x64" if machine in ("amd64", "x86_64", "x64") else "arm64"
    return (f"@img/sharp-win32-{arch}", f"@koromix/koffi-win32-{arch}",
            f"@vscode/ripgrep-win32-{arch}")


def _integrity(path: str) -> str:
    digest = hashlib.sha512(Path(path).read_bytes()).digest()
    return "sha512-" + base64.b64encode(digest).decode("ascii")


def _native_archive(folder: str, name: str, version: str) -> str:
    slug = name.replace("@", "").replace("/", "-")
    package = os.path.join(folder, slug, "package")
    _manifest(os.path.join(package, "package.json"),
              {"name": name, "version": version})
    if name.startswith("@vscode/ripgrep-win32-"):
        binary = Path(package) / "bin" / "rg.exe"
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_bytes(b"MZ fixture binary")
    archive = os.path.join(folder, slug + ".tgz")
    with tarfile.open(archive, "w:gz") as bundle:
        bundle.add(package, arcname="package")
    return archive


def _native_fixtures(folder: str) -> dict[str, dict]:
    fixtures = {}
    versions = ("0.35.3", "3.1.6", "1.18.0")
    for name, version in zip(_native_names(), versions):
        archive = _native_archive(folder, name, version)
        fixtures[name] = {
            "name": name, "version": version, "archive": archive,
            "integrity": _integrity(archive),
        }
    return fixtures


def _runtime_tree(root: str, fixtures: dict[str, dict],
                  *, install_native: bool) -> None:
    _manifest(os.path.join(root, "node_modules", "@deepseek-ai", "dsh",
                           "package.json"), {"version": VERSION})
    names = _native_names()
    if names:
        _manifest(os.path.join(root, "node_modules", "sharp", "package.json"), {
            "name": "sharp", "version": "0.35.3",
            "optionalDependencies": {names[0]: fixtures[names[0]]["version"]},
        })
        _manifest(os.path.join(root, "node_modules", "koffi", "package.json"), {
            "name": "koffi", "version": "3.1.6",
            "optionalDependencies": {names[1]: fixtures[names[1]]["version"]},
        })
        _manifest(os.path.join(root, "node_modules", "@vscode", "ripgrep", "package.json"), {
            "name": "@vscode/ripgrep", "version": "1.18.0",
            "optionalDependencies": {names[2]: fixtures[names[2]]["version"]},
        })
    packages = {}
    for name, item in fixtures.items():
        packages["node_modules/" + name] = {
            "version": item["version"], "integrity": item["integrity"],
            "optional": True,
        }
        if install_native:
            _manifest(os.path.join(root, "node_modules", *name.split("/"),
                                   "package.json"),
                      {"name": name, "version": item["version"]})
            if name.startswith("@vscode/ripgrep-win32-"):
                binary = Path(root) / "node_modules" / name / "bin" / "rg.exe"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(b"MZ fixture binary")
    _manifest(os.path.join(root, "package-lock.json"),
              {"lockfileVersion": 3, "packages": packages})


def _archive_tree(source: str, archive: str) -> str:
    with tarfile.open(archive, "w:gz") as bundle:
        for path in Path(source).rglob("*"):
            if path.is_file():
                bundle.add(str(path), arcname=path.relative_to(source).as_posix())
    return hashlib.sha256(Path(archive).read_bytes()).hexdigest()


class _CaptureInput(io.StringIO):
    """Writable fake stdin that remains inspectable after the probe closes it."""

    def __init__(self) -> None:
        super().__init__()
        self.snapshot = ""

    def close(self) -> None:
        self.snapshot = self.getvalue()


class _BlockingStream:
    def __init__(self, proc) -> None:
        self.proc = proc

    def readline(self) -> str:
        while not self.proc.killed:
            time.sleep(0.005)
        return ""


class _FakeProcess:
    def __init__(self, stdout: str = "", stderr: str = "",
                 returncode: int | None = None, *, blocking: bool = False) -> None:
        self.returncode = returncode
        self.killed = False
        self.stdin = _CaptureInput()
        if blocking:
            self.stdout = _BlockingStream(self)
            self.stderr = _BlockingStream(self)
        else:
            self.stdout = io.StringIO(stdout)
            self.stderr = io.StringIO(stderr)

    def poll(self):
        return self.returncode


def _long_path_extraction() -> None:
    # Real Windows I/O, including cleanup, without enabling machine-wide long paths.
    with tempfile.TemporaryDirectory(prefix="soduwork-dsh-path-") as folder:
        stage = tempfile.mkdtemp(prefix=".dsh-host-stage-", dir=folder)
        archive = os.path.join(folder, "runtime.tgz")
        member = "/".join(["node_modules", *(["nested-dependency-abcdefgh"] * 14), "module.js"])
        payload = b"module.exports = 'long-path-runtime';"
        with tarfile.open(archive, "w:gz") as bundle:
            info = tarfile.TarInfo(member)
            info.size = len(payload)
            bundle.addfile(info, io.BytesIO(payload))
        target = os.path.abspath(os.path.join(stage, *member.split("/")))
        assert len(target) > 350
        native_stage = "\\\\?\\" + stage if os.name == "nt" else stage
        native_target = "\\\\?\\" + target if os.name == "nt" else target
        try:
            dsh_runtime._safe_extract(archive, stage)
            assert Path(native_target).read_bytes() == payload
            dsh_runtime.discard_stage(stage)
            assert not os.path.exists(native_stage), "Deep runtime trees must be fully removed"
        finally:
            shutil.rmtree(native_stage, ignore_errors=True)


def main() -> int:
    _long_path_extraction()
    checks = 0
    with tempfile.TemporaryDirectory(prefix="soduwork-dsh-runtime-") as data_root:
        fixtures = _native_fixtures(os.path.join(data_root, "native-fixtures"))
        issue = dsh_runtime.runtime_issue(data_root, VERSION)
        assert "尚未准备好" in issue
        checks += 1

        root = dsh_runtime.host_root(data_root)
        _runtime_tree(root, fixtures, install_native=True)
        assert dsh_runtime.runtime_issue(data_root, VERSION) == ""
        checks += 1
        assert "版本不匹配" in dsh_runtime.runtime_issue(data_root, "9.9.9")
        checks += 1
        if _native_names():
            ripgrep = _native_names()[2]
            binary = Path(root) / "node_modules" / ripgrep / "bin" / "rg.exe"
            binary.unlink()
            assert ripgrep in dsh_runtime.runtime_issue(data_root, VERSION)
            binary.write_bytes(b"MZ fixture binary")
            assert dsh_runtime.runtime_issue(data_root, VERSION) == ""
            checks += 2

        env = {}
        dsh_runtime.apply_env(env, data_root)
        assert env["DSH_PATH"] == root and env["DSH_TELEMETRY_DISABLED"] == "1"
        checks += 1

        workspace = os.path.join(data_root, "workspace")
        os.makedirs(workspace, exist_ok=True)
        original_data_root = local_base._data_root
        try:
            local_base._data_root = lambda: data_root
            task_env = ai_local._env_for(ai_local._PROFILES["dsh"], {
                "local_workspace_root": workspace,
                "llm": {
                    "base": "http://127.0.0.1:9/v1",
                    "key": "runtime-test", "model": "runtime-test",
                },
            }, "dsh-session-one")
            second_env = ai_local._env_for(ai_local._PROFILES["dsh"], {
                "local_workspace_root": workspace,
                "llm": {"base": "http://127.0.0.1:9/v1", "key": "runtime-test", "model": "runtime-test"},
            }, "dsh-session-two")
        finally:
            local_base._data_root = original_data_root
        task_temp = task_env["TEMP"]
        assert os.path.isdir(task_temp)
        assert task_env["TEMP"] == task_env["TMP"] == task_env["TMPDIR"] == task_temp
        assert os.path.commonpath((workspace, task_temp)) not in (workspace, task_temp)
        assert not os.path.exists(os.path.join(workspace, "temp"))
        assert second_env["TEMP"] != task_temp
        assert task_env["DSH_HOME"] == os.path.join(data_root, ".dsh")
        stable_env = {"DSH_SANDBOX_MODE": "workspace-write"}
        assert dsh_runtime.prepare_temp(stable_env, data_root, "dsh-session-one", workspace) == task_temp
        assert stable_env["DSH_SANDBOX_MODE"] == "workspace-write"
        try:
            dsh_runtime.prepare_temp({}, data_root, "overlapping", data_root)
            raise AssertionError("runtime temp cannot lie inside its workspace")
        except RuntimeError as exc:
            assert "隔离" in str(exc)
        checks += 7

        blocked_path = False
        try:
            dsh_runtime._member_parts("../escape")
        except RuntimeError:
            blocked_path = True
        assert blocked_path
        checks += 1

        adapter = os.path.join(data_root, "adapter")
        source = os.path.join(data_root, "bundled-runtime")
        _runtime_tree(source, fixtures, install_native=False)
        vendor = os.path.join(adapter, "vendor")
        os.makedirs(vendor, exist_ok=True)
        archive = os.path.join(vendor, "dsh-runtime.tgz")
        archive_hash = _archive_tree(source, archive)
        adapter_manifest = os.path.join(adapter, "package.json")
        _manifest(adapter_manifest, {
            "name": "@openma/deepseek-harness-acp",
            "dshAcp": {"standaloneDsh": VERSION},
        })
        _manifest(os.path.join(vendor, "runtime.json"), {
            "archive": "dsh-runtime.tgz", "dsh": VERSION,
            "sha256": archive_hash,
        })
        assert dsh_runtime.adapter_expected_version(
            manifest_path=adapter_manifest) == VERSION
        bundle = dsh_runtime.adapter_runtime_bundle(
            manifest_path=adapter_manifest)
        assert bundle["sha256"] == archive_hash
        checks += 2

        previous = os.environ.get("SODUWORK_DSH_ACP_MANIFEST")
        os.environ["SODUWORK_DSH_ACP_MANIFEST"] = adapter_manifest
        stage = ""
        try:
            plan = dsh_runtime.stage_bundled_runtime(data_root)
            stage = plan["path"]
            assert plan["version"] == VERSION
            assert len(plan["nativePackages"]) == len(fixtures)
            checks += 2

            for spec in plan["nativePackages"]:
                argv = dsh_runtime.native_pack_argv("npm", stage, spec)
                assert argv[:3] == ["npm", "pack", "--json"]
                assert argv[-1] == f"{spec['name']}@{spec['version']}"
                destination = dsh_runtime.native_pack_dir(stage, spec)
                shutil.copyfile(fixtures[spec["name"]]["archive"],
                                os.path.join(destination, "package.tgz"))
                if spec["name"].startswith("@vscode/ripgrep-win32-"):
                    downloaded = Path(destination) / "package.tgz"
                    downloaded.write_bytes(downloaded.read_bytes() + b"tampered")
                    try:
                        dsh_runtime.install_native_pack(stage, spec)
                        raise AssertionError("tampered ripgrep package was accepted")
                    except RuntimeError as exc:
                        assert "校验失败" in str(exc)
                    shutil.copyfile(fixtures[spec["name"]]["archive"], downloaded)
                    checks += 1
                dsh_runtime.install_native_pack(stage, spec)
                checks += 3

            assert "不存在" in dsh_runtime.stage_boot_issue(
                "", stage, VERSION)
            checks += 1
            dsh_runtime.activate_stage(
                stage, data_root, VERSION, plan["sha256"])
            stage = ""
        finally:
            dsh_runtime.discard_stage(stage)
            if previous is None:
                os.environ.pop("SODUWORK_DSH_ACP_MANIFEST", None)
            else:
                os.environ["SODUWORK_DSH_ACP_MANIFEST"] = previous
        assert dsh_runtime.runtime_issue(data_root, VERSION) == ""
        assert os.path.isfile(os.path.join(root, ".soduwork-dsh-runtime.json"))
        checks += 2

        home_env = {}
        acp_agents.home_env("dsh", home_env, data_root)
        assert home_env["DSH_PATH"] == root
        assert home_env["DSH_HOME"] == os.path.join(os.path.abspath(data_root), ".dsh")
        checks += 2

        profile = acp_agents.profile("dsh")
        assert callable(profile.get("runtime_issue"))
        assert callable(profile.get("runtime_probe"))
        checks += 2

        blocked = {"runtime_probe": lambda: "runtime blocked"}
        assert ai_local._profile_runtime_issue(blocked, probe=True) == "runtime blocked"
        assert not ai_local._profile_runtime_issue({}, probe=True)
        checks += 2

        original_profile = ai_local._PROFILES["dsh"]
        before_runs = set(ai_local._RUNS)
        try:
            ai_local._PROFILES["dsh"] = {
                "name": "DeepSeek Harness", "bin": lambda: sys.executable,
                "runtime_probe": lambda: "runtime blocked",
            }
            result = ai_local._dispatch_sync_once(
                {}, SimpleNamespace(id="probe", title="probe", note=""),
                assignee={"id": "local:dsh"}, ctx={})
            assert result == {"ok": False, "error": "runtime blocked"}
            assert set(ai_local._RUNS) == before_runs
        finally:
            ai_local._PROFILES["dsh"] = original_profile
        checks += 2

        original_popen = dsh_runtime.subprocess.Popen
        original_kill = dsh_runtime._kill_tree
        spawned = []

        def fake_kill(proc) -> None:
            proc.killed = True
            if proc.returncode is None:
                proc.returncode = -9

        def use_process(proc):
            spawned.append(proc)
            dsh_runtime.subprocess.Popen = lambda *args, **kwargs: proc

        try:
            dsh_runtime._kill_tree = fake_kill
            response = json.dumps({
                "jsonrpc": "2.0", "id": "soduwork-dsh-runtime-probe",
                "result": {
                    "protocolVersion": 1,
                    "agentInfo": {"name": "dsh-acp", "version": "test"},
                    "agentCapabilities": {},
                },
            }) + "\n"
            success = _FakeProcess(stdout=response)
            use_process(success)
            assert dsh_runtime._probe_runtime(
                "fake-dsh", root, os.path.join(data_root, "probe-ok"), 0.3) == ""
            request = json.loads(success.stdin.snapshot)
            assert request["method"] == "initialize"
            assert request["params"]["protocolVersion"] == 1
            assert request["params"]["clientInfo"]["name"] == "soduwork-runtime-probe"
            checks += 4

            early = _FakeProcess(
                stderr="plugin tree failed to load: Cannot find module sharp\n",
                returncode=2)
            use_process(early)
            assert "原生组件" in dsh_runtime._probe_runtime(
                "fake-dsh", root, os.path.join(data_root, "probe-early"), 0.3)
            checks += 1

            rejected = _FakeProcess(stdout=json.dumps({
                "jsonrpc": "2.0", "id": "soduwork-dsh-runtime-probe",
                "error": {"code": -32000, "message": "configuration rejected"},
            }) + "\n")
            use_process(rejected)
            assert "configuration rejected" in dsh_runtime._probe_runtime(
                "fake-dsh", root, os.path.join(data_root, "probe-error"), 0.3)
            checks += 1

            incomplete = _FakeProcess(stdout=json.dumps({
                "jsonrpc": "2.0", "id": "soduwork-dsh-runtime-probe",
                "result": {"protocolVersion": 1},
            }) + "\n")
            use_process(incomplete)
            assert "返回内容不完整" in dsh_runtime._probe_runtime(
                "fake-dsh", root, os.path.join(data_root, "probe-incomplete"), 0.3)
            checks += 1

            stalled = _FakeProcess(blocking=True)
            use_process(stalled)
            assert "超时" in dsh_runtime._probe_runtime(
                "fake-dsh", root, os.path.join(data_root, "probe-timeout"), 0.05)
            checks += 1
        finally:
            dsh_runtime.subprocess.Popen = original_popen
            dsh_runtime._kill_tree = original_kill

        dsh_runtime.remove_host(data_root)
        assert not os.path.exists(root)
        checks += 1

    print(f"DSH_RUNTIME_OK: {checks} assertions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
