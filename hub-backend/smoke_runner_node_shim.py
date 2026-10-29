"""Verify the Node shim conditions and real subprocess startup in bash and cmd.

The MCP bridge and browser skill require Node 22 or newer. Without standalone Node,
the Runner creates a shim using the client's bundled Electron and ELECTRON_RUN_AS_NODE=1.
Cover PATH precedence, command generation, and child-process startup.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, ".")

from runner_main import _ensure_node_shim  # noqa: E402
from client_test_payload import windows_payload  # noqa: E402

SYSTEM32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")

passed = failed = 0


def ok(cond, name, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


def main() -> int:
    bare = SYSTEM32
    with tempfile.TemporaryDirectory() as data_root:
        # Release checks run before native packaging. Use a real temporary
        # payload for branch/content checks; --native additionally exercises
        # Electron and PortableGit produced by package:windows.
        fixture_node = Path(data_root) / "bundled node.exe"
        fixture_node.write_bytes(b"fixture")
        bundled_node = str(fixture_node)
        ok(_ensure_node_shim(bare, "", data_root) == bare,
           "没有内置 node（独立执行机）：PATH 原样不动")
        ok(_ensure_node_shim(bare, r"C:\not\exist\electron.exe", data_root) == bare,
           "内置 node 路径不存在：PATH 原样不动")
        ok(_ensure_node_shim(bare, bundled_node, data_root,
                             which=lambda *_a, **_k: r"C:\nodejs\node.exe",
                             node_major=lambda _p: 24) == bare,
           "机器自己有 Node ≥22：一个字都不动")
        old_node = _ensure_node_shim(bare, bundled_node, data_root,
                                     which=lambda *_a, **_k: r"C:\old\node.exe",
                                     node_major=lambda _p: 16)
        ok(old_node.split(os.pathsep)[0] == os.path.join(data_root, "node-shim"),
           "★Node 版本太老（<22）：垫片挂在老 node 前面（真机同事就卡在这）", old_node)

        mounted = _ensure_node_shim(bare, bundled_node, data_root,
                                    which=lambda *_a, **_k: None)
        shim_dir = os.path.join(data_root, "node-shim")
        ok(mounted.split(os.pathsep)[0] == shim_dir
           and os.path.isfile(os.path.join(shim_dir, "node.cmd"))
           and os.path.isfile(os.path.join(shim_dir, "node")),
           "裸机：垫片写出 node.cmd 与 node 两个形态并挂 PATH 最前", mounted)

        cmd_bytes = (Path(shim_dir) / "node.cmd").read_bytes()
        sh_bytes = (Path(shim_dir) / "node").read_bytes()
        ok(cmd_bytes == ('@echo off\r\nsetlocal DisableDelayedExpansion\r\n'
                         'set ELECTRON_RUN_AS_NODE=1\r\n"%SODUWORK_NODE_SHIM_EXECUTABLE%" %*\r\n'
                         'exit /b %errorlevel%\r\n').encode("ascii"),
           "cmd 垫片保留 CRLF、路径引用、环境变量与参数转发")
        ok(sh_bytes == ('#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "%s" "$@"\n'
                        % bundled_node.replace("\\", "/")).encode("utf-8"),
           "bash 垫片保留 LF、路径引用、环境变量与参数转发")
        if os.name != "nt":
            node = shutil.which("node")
            ok(bool(node), "可移植 spawn 检查需要 CI 的 Node")
            if node:
                # Reproduce an existing 0644 wrapper left by older releases.
                (Path(shim_dir) / "node").chmod(0o644)
                mounted = _ensure_node_shim("", node, data_root, which=lambda *_a, **_k: None)
                ok(shutil.which("node", path=mounted) == str(Path(shim_dir) / "node"),
                   "升级修复后 PATH 可以直接发现 node")
                probe = subprocess.run([
                    "node", "-e",
                    "console.log(process.env.ELECTRON_RUN_AS_NODE, process.argv[1])", "two words",
                ], env={**os.environ, "PATH": mounted}, capture_output=True, text=True, timeout=30)
                ok(probe.returncode == 0 and probe.stdout.strip() == "1 two words",
                   "直接启动 node 垫片且保留带空格参数", probe.stderr)
                with tempfile.TemporaryDirectory() as private_root:
                    previous_umask = os.umask(0o077)
                    try:
                        private_path = _ensure_node_shim("", node, private_root)
                    finally:
                        os.umask(previous_umask)
                    ok(os.stat(Path(private_path) / "node").st_mode & 0o777 == 0o700,
                       "严格 umask 下新建垫片可执行且不放宽其他用户权限")

        if "--native" not in sys.argv:
            print(f"runner node shim smoke: {passed} passed, {failed} failed")
            return 1 if failed else 0
        _, electron, shell = windows_payload()
        mounted = _ensure_node_shim(bare, str(electron), data_root,
                                    which=lambda *_a, **_k: None)
        if not electron.is_file():
            ok(False, "找不到打包后的 Electron，原生检查失败", electron)
        else:
            env = {**os.environ, "PATH": mounted}
            env.pop("ELECTRON_RUN_AS_NODE", None)
            cmd_probe = subprocess.run(
                ["cmd", "/d", "/c", "node", "--version"], env=env,
                capture_output=True, timeout=120)
            out = (cmd_probe.stdout or b"").decode("utf-8", "replace").strip()
            major = int(out.lstrip("v").split(".")[0]) if out.startswith("v") else 0
            ok(cmd_probe.returncode == 0 and major >= 22,
               "★真 spawn（cmd 形态）：node --version 报 Node %d ≥ 22" % major,
               (cmd_probe.returncode, out[-80:],
                (cmd_probe.stderr or b"").decode("utf-8", "replace")[-160:]))
            bundled_bash = str(shell / "bin" / "bash.exe")
            if os.path.isfile(bundled_bash):
                bash_probe = subprocess.run(
                    [bundled_bash, "-c", "node -e 'console.log(process.version)'"],
                    env=env, capture_output=True, timeout=120)
                bout = (bash_probe.stdout or b"").decode("utf-8", "replace").strip()
                ok(bash_probe.returncode == 0 and bout.startswith("v2"),
                   "★真 spawn（bash 形态）：会话里敲 node 走通垫片（%s）" % bout,
                   (bash_probe.returncode, bout,
                    (bash_probe.stderr or b"").decode("utf-8", "replace")[-160:]))
            else:
                ok(False, "内置 bash 缺失，bash 形态未验", bundled_bash)

    print(f"runner node shim smoke: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
