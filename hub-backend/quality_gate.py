"""Tiered quality gates for SoduWork backend, client and admin packages."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

from quality_manifest import (
    GROUPS,
    RELEASE_SMOKES,
    audit_manifest,
    missing_live_requirements,
    scripts_for,
)


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "hub-backend"
CLIENT = ROOT / "client"
FRONTEND = ROOT / "hub-frontend"

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

LIVE_ACK = "SODUWORK_ALLOW_LIVE_GATE"
LIVE_ENV_KEYS = ("SMOKE_ALLOW_LIVE_DB", "SODUWORK_SMOKE_LIVE_AI", "SMOKE_BASE")

# The isolated admin dispatch suite takes over five minutes on Windows. Keep a
# finite per-module deadline without changing the default for other checks.
CHECK_TIMEOUTS = {
    "smoke_plugins.py": 1800,
    "smoke_schema_migrations.py": 1800,
    "test_admin_requirement_dispatch.py": 600,
}


def _npm() -> str:
    executable = shutil.which("npm.cmd" if os.name == "nt" else "npm") or shutil.which("npm")
    if not executable:
        raise RuntimeError("npm is required for the full quality gate")
    return executable


def _node() -> str:
    executable = shutil.which("node.exe" if os.name == "nt" else "node") or shutil.which("node")
    if not executable:
        raise RuntimeError("node is required for the full quality gate")
    return executable


def _run(name: str, args: list[str], cwd: Path, env: dict[str, str], timeout: int) -> tuple[bool, str]:
    started = time.monotonic()
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        shell=False,
    )
    elapsed = time.monotonic() - started
    state = "PASS" if result.returncode == 0 else "FAIL"
    print(f"[{state}] {name} ({elapsed:.1f}s)", flush=True)
    output = result.stdout or ""
    if result.returncode != 0:
        output = f"Process exit code: {result.returncode}\n" + output
        print(output, flush=True)
    return result.returncode == 0, output


def _isolated_env(base: dict[str, str], root: Path, index: int, name: str) -> dict[str, str]:
    """Give every offline check its own database and data root."""
    env = base.copy()
    slug = "".join(char if char.isalnum() else "-" for char in name).strip("-")[:70]
    check_root = root / f"{index:03d}-{slug}"
    check_root.mkdir(parents=True, exist_ok=True)
    # The database guard also protects test_* entrypoints. Mark the filename
    # explicitly instead of depending on a smoke-* substring in a script name.
    env["DATABASE_URL"] = "sqlite+aiosqlite:///" + (check_root / ".smoke.db").as_posix()
    env["SODUWORK_DATA_ROOT"] = str(check_root / "data")
    env["SKIN_DATA_ROOT"] = str(check_root / "skin-data")
    env["CLUSTER_REDIS_URL"] = ""
    env["SODUWORK_ENV"] = "development"
    env["AUTH_SECRET"] = secrets.token_hex(32)
    env["ADMIN_PASS"] = secrets.token_hex(20)
    # Offline fixtures listen on loopback even when the developer uses a proxy.
    for key in ("NO_PROXY", "no_proxy"):
        env[key] = ",".join(filter(None, [env.get(key, ""), "localhost", "127.0.0.1", "::1"]))
    return env


def _python_check_command(script: str) -> list[str]:
    # Unittest modules need discovery even when they omit a __main__ block.
    if script.startswith("test_"):
        return [sys.executable, "-m", "unittest", "-v", script.removesuffix(".py")]
    return [sys.executable, script]


def _print_manifest() -> None:
    descriptions = {
        "release": "发布必跑：离线、确定性、隔离用户数据",
        "extended": "扩展回归：发布必跑项 + 浏览器/本机监听/长子进程检查",
        "live": "真实环境：只跑真实 Hub/Runner/模型/凭据检查，绝不自动触发",
    }
    for tier in ("release", "extended", "live"):
        names = GROUPS[tier]
        effective = scripts_for(tier)
        print(f"\n{tier.upper()} · {descriptions[tier]}")
        if tier == "extended":
            print(f"  共 {len(effective)} 项（{len(RELEASE_SMOKES)} 发布 + {len(names)} 扩展）")
        else:
            print(f"  共 {len(names)} 项")
        for name in names:
            print("  - " + name)
    print(f"\n真实环境门禁需显式设置 {LIVE_ACK}=1；部分检查还需要：")
    print("  SMOKE_ALLOW_LIVE_DB=1 · SODUWORK_SMOKE_LIVE_AI=1 · SMOKE_BASE=<Hub 地址>")


def main() -> int:
    parser = argparse.ArgumentParser(description="SoduWork deterministic quality gate")
    parser.add_argument("--scope", choices=("backend", "all"), default="all")
    parser.add_argument("--profile", choices=("release", "extended", "live"), default="release",
                        help="release is offline; extended adds platform checks; live is explicit")
    parser.add_argument("--browser", action="store_true", help="also run the real-browser repaint smoke")
    parser.add_argument("--list", action="store_true", help="show every registered smoke and exit")
    args = parser.parse_args()

    manifest_errors = audit_manifest(BACKEND)
    if manifest_errors:
        print("QUALITY MANIFEST INVALID")
        for error in manifest_errors:
            print("  - " + error)
        return 2
    if args.list:
        _print_manifest()
        return 0
    if args.profile == "live":
        if os.environ.get(LIVE_ACK) != "1":
            print(f"REFUSED: live checks can touch real services. Set {LIVE_ACK}=1 explicitly.")
            return 2
        missing = missing_live_requirements(os.environ)
        if missing:
            print("REFUSED: the complete live profile is missing explicit prerequisites:")
            for requirement in missing:
                print("  - " + requirement)
            return 2

    smoke_scripts = list(scripts_for(args.profile))
    if args.browser and "smoke_client_render.py" not in smoke_scripts:
        smoke_scripts.append("smoke_client_render.py")
    print(f"SoduWork quality gate · {args.profile} · {len(smoke_scripts)} smoke checks", flush=True)

    failures: list[tuple[str, str]] = []
    with tempfile.TemporaryDirectory(prefix="soduwork-gate-") as directory:
        safe_root = Path(directory)
        base_env = os.environ.copy()
        # Child checks must not inherit the Windows console code page. A smoke
        # name may contain symbols outside GBK; output encoding must never turn
        # a passing assertion into a UnicodeEncodeError.
        base_env["PYTHONIOENCODING"] = "utf-8"
        base_env["PYTHONUTF8"] = "1"
        if args.profile != "live":
            base_env.pop(LIVE_ACK, None)
            for key in LIVE_ENV_KEYS:
                base_env.pop(key, None)

        checks: list[tuple[str, list[str], Path, int]] = [
            (
                "python syntax",
                [sys.executable, "-c",
                 "from pathlib import Path; "
                 "files=sorted(Path('app').rglob('*.py'))+[Path('runner_main.py'),Path('db_admin.py')]; "
                 "[compile(path.read_bytes(),str(path),'exec') for path in files]; "
                 "print(f'{len(files)} Python files compiled without writing bytecode')"],
                BACKEND,
                120,
            )
        ]
        checks.extend(
            (script.removesuffix(".py"), _python_check_command(script), BACKEND,
             CHECK_TIMEOUTS.get(script, 300))
            for script in smoke_scripts
        )

        if args.scope == "all":
            checks += [
                ("SoduWork brand keyword gate", [_node(), "tools/brand-keyword-gate.cjs"], ROOT, 120),
                ("client tests", [_npm(), "test"], CLIENT, 300),
                ("admin production build", [_npm(), "run", "build"], FRONTEND, 300),
            ]
        for index, (name, command, cwd, timeout) in enumerate(checks):
            check_env = (base_env if args.profile == "live"
                         else _isolated_env(base_env, safe_root, index, name))
            try:
                passed, output = _run(name, command, cwd, check_env, timeout)
            except subprocess.TimeoutExpired as exc:
                passed, output = False, f"timed out after {exc.timeout}s"
                print(f"[FAIL] {name} (timeout)", flush=True)
            except Exception as exc:
                passed, output = False, str(exc)
                print(f"[FAIL] {name} ({exc})", flush=True)
            if not passed:
                failures.append((name, output[-6000:]))

    if failures:
        print("\nQUALITY GATE FAILED")
        for name, output in failures:
            print(f"\n--- {name} ---\n{output}")
        return 1
    print("\nQUALITY GATE PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
