"""Process-isolated plugin scenarios; imports never initialize a database."""
import asyncio
from dataclasses import dataclass, field
import importlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback


GROUPS = {
    "contracts": ("catalog", "packages"),
    "bindings": ("bindings",),
    "execution": ("receipts", "git", "decisions"),
    "recovery": ("recovery",),
    "review": ("review",),
    "deployments": ("deployments",),
    "builtin": ("builtin",),
}
CASE_MODULES = {
    "catalog": "contracts", "packages": "contracts", "bindings": "bindings",
    "receipts": "execution", "git": "execution", "decisions": "execution",
    "recovery": "recovery", "review": "review", "deployments": "review", "builtin": "builtin",
}
APPROVED_CASES = {"receipts", "git", "decisions", "recovery", "review"}
PURE_CASES = {"catalog", "packages"}


@dataclass
class Report:
    passed: int = 0
    failed: int = 0
    lines: list[str] = field(default_factory=list)

    def check(self, name, condition, extra=""):
        if condition:
            self.passed += 1
            self.lines.append("  PASS  " + name)
        else:
            self.failed += 1
            self.lines.append("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


async def _run_case(name, report):
    # The caller sets isolated settings before any application module is imported.
    from app.db import SessionLocal, engine, init_db
    try:
        module = importlib.import_module("plugin_smoke." + CASE_MODULES[name])
        check = getattr(module, name)
        if name in PURE_CASES:
            await check(report.check)
            return
        await init_db()
        from app.services import release_control
        from .fixtures import actor_fixture, approved_plugin_fixture
        async with SessionLocal() as session:
            await release_control.bootstrap(session)
            if name == "builtin":
                await check(report.check, session)
            else:
                actor = await actor_fixture(session)
                if name in APPROVED_CASES:
                    approved = await approved_plugin_fixture(actor)
                    await check(report.check, actor, approved)
                else:
                    await check(report.check, actor)
    finally:
        await engine.dispose()


def run_case(name):
    report = Report()
    with tempfile.TemporaryDirectory(prefix="soduwork-plugin-smoke-") as directory:
        root = Path(directory)
        os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (root / ".smoke.db").as_posix()
        os.environ["SODUWORK_DATA_ROOT"] = str(root / "data")
        try:
            asyncio.run(_run_case(name, report))
        except Exception as exc:
            traceback.print_exc()
            report.check("场景完整执行：" + name, False, type(exc).__name__ + ": " + str(exc))
    print("\n".join(report.lines))
    print(f"plugin smoke [{name}]: {report.passed} passed, {report.failed} failed", flush=True)
    return 1 if report.failed else 0


def run_groups(groups, *, execute=None, entry=None):
    """Every case gets a clean interpreter, database, data root and patch lifetime."""
    execute = execute or subprocess.run
    entry = entry or Path(__file__).resolve().parents[1] / "smoke_plugins.py"
    failed = []
    for group in groups:
        print("Plugin smoke group: " + group, flush=True)
        for case in GROUPS[group]:
            result = execute([sys.executable, str(entry), "--case", case], check=False)
            if result.returncode:
                failed.append(case)
    if failed:
        print("Plugin smoke failed cases: " + ", ".join(failed), flush=True)
    return 1 if failed else 0
