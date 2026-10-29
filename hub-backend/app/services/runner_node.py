"""Expose the bundled Electron runtime as Node on machines without Node 22+."""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess

log = logging.getLogger("runner")


def _node_major(node: str) -> int:
    try:
        probe = subprocess.run([node, "--version"], capture_output=True,
                               timeout=10, text=True, errors="replace")
        match = re.search(r"v?(\d+)", probe.stdout or "")
        return int(match.group(1)) if probe.returncode == 0 and match else 0
    except Exception:  # noqa: BLE001
        return 0


def ensure_node_shim(path_value: str, bundled_node: str, data_root: str,
                     which=shutil.which, node_major=None) -> str:
    """Keep a suitable system Node; otherwise provide cmd and POSIX wrappers."""
    exe = str(bundled_node or "").strip()
    if not exe or not os.path.isfile(exe):
        return path_value
    probe = node_major or _node_major
    found = which("node", path=path_value)
    if found and probe(found) >= 22:
        return path_value
    shim_dir = os.path.join(str(data_root or "") or os.getcwd(), "node-shim")
    try:
        os.makedirs(shim_dir, exist_ok=True)
        cmd_shim = os.path.join(shim_dir, "node.cmd")
        # cmd reads batch bytes using its active code page. Keep the wrapper
        # ASCII and pass the path through Windows' Unicode environment block;
        # switching chcp would affect the Agent's shared console. Disable delayed
        # expansion so a literal ! in an installation path remains unchanged.
        with open(cmd_shim, "w", encoding="ascii", newline="\r\n") as f:
            f.write('@echo off\nsetlocal DisableDelayedExpansion\n'
                    'set ELECTRON_RUN_AS_NODE=1\n"%SODUWORK_NODE_SHIM_EXECUTABLE%" %*\n'
                    'exit /b %errorlevel%\n')
        sh_shim = os.path.join(shim_dir, "node")
        with open(sh_shim, "w", encoding="utf-8", newline="\n") as f:
            f.write('#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "%s" "$@"\n'
                    % exe.replace("\\", "/"))
        if os.name != "nt":
            # Repair old wrappers while retaining main's owner-only access.
            os.chmod(sh_shim, 0o700)
    except OSError as e:
        log.warning("node 垫片写入失败（浏览/MCP 能力将继续要求系统 Node）: %s",
                    type(e).__name__)
        return path_value
    if os.name == "nt":
        # Agent and terminal environments inherit this non-secret path. Publish
        # it only after both wrappers have been written successfully.
        os.environ["SODUWORK_NODE_SHIM_EXECUTABLE"] = exe
    return os.pathsep.join([shim_dir] + ([path_value] if path_value else []))
