"""Regression checks for public module contracts."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, ".")

from runner_main import _with_bundled_shell  # noqa: E402
from client_test_payload import windows_payload  # noqa: E402

SYSTEM32 = (os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
            if os.name == "nt" else "/nonexistent/soduwork-bare-system")

passed = failed = 0


def ok(cond, name, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


def check_paths(bundled: str) -> str:
    bare = SYSTEM32  # Simulate a host PATH containing system tools but no bash or Git.

    # Verify pure path-selection behavior.
    ok(_with_bundled_shell(bare, "") == bare, "没传内置 Shell：PATH 原样不动")
    ok(_with_bundled_shell(bare, r"C:\not\exist") == bare,
       "传了不存在的目录：PATH 原样不动")
    ok(_with_bundled_shell(bare, bundled, which=lambda *_a, **_k: r"C:\Git\bash.exe") == bare,
       "机器上已有 bash：一个字都不改（别把 msys 工具挡在系统工具前）")
    wsl_mounted = _with_bundled_shell(
        bare, bundled, which=lambda *_a, **_k: r"C:\Windows\System32\bash.EXE")
    ok(wsl_mounted.split(os.pathsep)[0] == os.path.join(bundled, "bin"),
       "★System32 的 WSL bash 不算可用 bash：照样挂内置（没发行版会直接报错，"
       "有发行版也是 Linux 环境）", wsl_mounted)
    mounted = _with_bundled_shell(bare, bundled, which=lambda *_a, **_k: None)
    parts = mounted.split(os.pathsep)
    ok(parts[:3] == [os.path.join(bundled, "bin"), os.path.join(bundled, "usr", "bin"),
                     os.path.join(bundled, "cmd")] and parts[3] == bare,
       "裸机：bin/usr\\bin/cmd 依次挂在 PATH 最前", mounted)
    ok(_with_bundled_shell("", bundled, which=lambda *_a, **_k: None).count(os.pathsep) == 2,
       "空 PATH 也能挂载（不留尾分隔符）")
    return mounted


def check_spawn(bundled: str, mounted: str) -> None:
    # Resolve the bundled bash from the prepared PATH before spawning.
    # Use its absolute path for the real command.
    # Windows executable discovery can use the parent process's PATH.
    # Avoid mixing system Git binaries with bundled MSYS tools.
    env = {**os.environ, "PATH": mounted}
    bundled_bash = os.path.join(bundled, "bin", "bash.exe")
    probe = subprocess.run(
        [bundled_bash, "-c", "printf SODUWORK_BARE_OK && git --version >/dev/null && "
                             "echo hi | sed s/hi/ok/ | grep -q ok && printf _TOOLS"],
        env=env, capture_output=True, timeout=60)
    out = (probe.stdout or b"").decode("utf-8", "replace")
    err = (probe.stderr or b"").decode("utf-8", "replace")
    ok(probe.returncode == 0 and "SODUWORK_BARE_OK_TOOLS" in out,
       "★真 spawn：裸机 PATH + 内置 Shell 跑通 bash/git/sed/grep",
       (probe.returncode, out[-100:], err[-200:]))

    # Verify packaging retains the actual bundled bash executable.
    ok(os.path.isfile(os.path.join(bundled, "bin", "bash.exe"))
       and os.path.isfile(os.path.join(bundled, "cmd", "git.exe")),
       "内置 Shell 根目录形状正确（bin/bash.exe + cmd/git.exe）")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="soduwork-shell-fixture-") as root:
        for directory in ("bin", "usr/bin", "cmd"):
            (Path(root) / directory).mkdir(parents=True)
        if os.name == "nt":
            (Path(root) / "bin/bash.exe").write_bytes(b"fixture")
            (Path(root) / "cmd/git.exe").write_bytes(b"fixture")
        else:
            # Exercise the same mount and spawn behavior with native tools,
            # without downloading or trying to run Windows executables.
            for command, relative in (("bash", "bin/bash.exe"), ("git", "cmd/git.exe"),
                                      ("git", "cmd/git"), ("sed", "usr/bin/sed"),
                                      ("grep", "usr/bin/grep")):
                executable = shutil.which(command)
                if not executable:
                    raise RuntimeError(f"CI tool required: {command}")
                (Path(root) / relative).symlink_to(executable)
        mounted = check_paths(root)
        if os.name != "nt":
            check_spawn(root, mounted)
    if "--native" in sys.argv:
        _, _, shell = windows_payload()
        bundled = str(shell)
        check_spawn(bundled, check_paths(bundled))
    print(f"runner shell path smoke: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
