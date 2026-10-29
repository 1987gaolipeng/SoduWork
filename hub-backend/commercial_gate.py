"""Fail-closed commercial release gate with an auditable, secret-free receipt."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import shutil
import subprocess
import sys
import threading
import time
from typing import Callable

from commercial_acceptance_manifest import (
    JOURNEYS,
    SCHEMA_VERSION,
    audit as audit_acceptance,
)
from quality_manifest import GROUPS


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "hub-backend"
CLIENT = ROOT / "client"


@dataclass(frozen=True)
class Check:
    key: str
    label: str
    argv: tuple[str, ...]
    cwd: Path
    timeout: int


def _npm() -> str:
    value = shutil.which("npm.cmd" if os.name == "nt" else "npm") or shutil.which("npm")
    if not value:
        raise RuntimeError("npm is required for the commercial gate")
    return value


def build_plan(profile: str, *, hub: str = "http://127.0.0.1:9080",
               cdp_port: int = 9222) -> tuple[Check, ...]:
    if profile not in {"release", "candidate", "live"}:
        raise ValueError("unknown commercial profile: " + profile)
    quality_profile = "release" if profile == "release" else "extended"
    checks = [Check(
        key="quality",
        label=f"{quality_profile} quality gate",
        argv=(sys.executable, "quality_gate.py", "--profile", quality_profile,
              "--scope", "all"),
        cwd=BACKEND,
        timeout=3600,
    )]
    if profile in {"candidate", "live"}:
        checks.append(Check(
            key="product-journeys",
            label="real Electron user journeys",
            argv=(_npm(), "run", "test:e2e:user", "--",
                  f"--hub={hub.rstrip('/')}", f"--port={int(cdp_port)}"),
            cwd=CLIENT,
            timeout=600,
        ))
    if profile == "live":
        checks.append(Check(
            key="live-integrations",
            label="explicit live integration gate",
            argv=(sys.executable, "quality_gate.py", "--profile", "live",
                  "--scope", "backend"),
            cwd=BACKEND,
            timeout=3600,
        ))
    return tuple(checks)


def _stop_process_tree(process: subprocess.Popen) -> None:
    """Stop the whole check tree so a timeout cannot leave workers behind."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=10, shell=False)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        process.kill()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass


def _run(check: Check) -> tuple[int, int]:
    started = time.monotonic()
    options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
               if os.name == "nt" else {"start_new_session": True})
    child_env = os.environ.copy()
    child_env["PYTHONUTF8"] = "1"
    child_env["PYTHONIOENCODING"] = "utf-8"
    process = subprocess.Popen(
        list(check.argv), cwd=check.cwd, env=child_env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, encoding="utf-8",
        errors="replace", bufsize=1, shell=False, **options)
    events: queue.Queue[object] = queue.Queue()
    reader_finished = object()

    def _read_output() -> None:
        assert process.stdout is not None
        try:
            for line in process.stdout:
                events.put(line)
        finally:
            process.stdout.close()
            events.put(reader_finished)

    reader = threading.Thread(target=_read_output, daemon=True,
                              name="commercial-gate-output")
    reader.start()
    deadline = started + check.timeout
    stream_done = False
    timed_out = False
    while not stream_done:
        if process.poll() is None and time.monotonic() >= deadline:
            timed_out = True
            print(f"{check.label} timed out after {check.timeout}s", flush=True)
            _stop_process_tree(process)
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            continue
        if event is reader_finished:
            stream_done = True
        else:
            line = str(event)
            print(line, end="" if line.endswith("\n") else "\n", flush=True)
    reader.join(timeout=1)
    if process.poll() is None:
        _stop_process_tree(process)
    code = 124 if timed_out else int(process.wait())
    return code, int((time.monotonic() - started) * 1000)


def execute_plan(checks: tuple[Check, ...], *,
                 runner: Callable[[Check], tuple[int, int]] = _run) -> list[dict]:
    """Run sequentially; a failed foundation skips all dependent checks."""
    results: list[dict] = []
    blocked = False
    for check in checks:
        if blocked:
            results.append({"key": check.key, "label": check.label,
                            "status": "skipped", "exitCode": None,
                            "durationMs": 0})
            continue
        print(f"\n[RUN] {check.label}", flush=True)
        code, duration = runner(check)
        status = "passed" if code == 0 else "failed"
        print(f"[{status.upper()}] {check.label} ({duration}ms)", flush=True)
        results.append({"key": check.key, "label": check.label,
                        "status": status, "exitCode": code,
                        "durationMs": max(0, int(duration))})
        blocked = code != 0
    return results


def _commit() -> str:
    deployed = str(os.environ.get("SODUWORK_DEPLOY_COMMIT") or "").strip()
    if deployed:
        return deployed[:64]
    try:
        value = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ROOT,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="ascii",
            errors="replace", timeout=10, shell=False)
        return value.stdout.strip()[:64] if value.returncode == 0 else ""
    except Exception:
        return ""

def _workspace_state() -> str:
    try:
        value = subprocess.run(
            ["git", "status", "--porcelain=v1"], cwd=ROOT,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
            errors="replace", timeout=15, shell=False)
        if value.returncode != 0:
            return "unknown"
        return "dirty" if value.stdout.strip() else "clean"
    except Exception:
        return "unknown"


def requires_receipt(profile: str) -> bool:
    return profile in {"candidate", "live"}


def build_receipt(profile: str, results: list[dict], *, started_at: str,
                  finished_at: str, commit: str = "",
                  source_tree: str = "unknown") -> dict:
    status = "passed" if results and all(
        item.get("status") == "passed" for item in results
    ) and (profile == "release" or source_tree == "clean") else "blocked"
    receipt = {
        "schemaVersion": SCHEMA_VERSION,
        "profile": profile,
        "status": status,
        "commit": (commit or _commit())[:64],
        "sourceTree": source_tree,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "journeys": [
            {"id": key, "tier": item["tier"], "roles": list(item["roles"]),
             "layers": [name for name in ("deterministic", "product", "live")
                        if item.get(name)]}
            for key, item in JOURNEYS.items()
        ],
        "checks": [dict(item) for item in results],
    }
    canonical = json.dumps(receipt, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8")
    receipt["fingerprint"] = hashlib.sha256(canonical).hexdigest()
    return receipt


def write_receipt(path: Path, receipt: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(receipt, ensure_ascii=False, indent=2) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(payload)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> int:
    parser = argparse.ArgumentParser(description="SoduWork commercial acceptance gate")
    parser.add_argument("--profile", choices=("release", "candidate", "live"),
                        default="candidate")
    parser.add_argument("--hub", default="http://127.0.0.1:9080")
    parser.add_argument("--cdp-port", type=int, default=9222)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    errors = audit_acceptance(BACKEND, GROUPS)
    if errors:
        print("COMMERCIAL ACCEPTANCE MANIFEST INVALID")
        for error in errors:
            print("  - " + error)
        return 2
    plan = build_plan(args.profile, hub=args.hub, cdp_port=args.cdp_port)
    if args.dry_run:
        print(f"{args.profile}: {len(plan)} checks, {len(JOURNEYS)} user journeys")
        for check in plan:
            print("  - " + check.label)
        return 0
    if requires_receipt(args.profile) and not args.report:
        print("candidate and live gates require an immutable --report path")
        return 2

    source_tree = _workspace_state()
    source_commit = _commit()
    if requires_receipt(args.profile) and (
            source_tree != "clean" or not source_commit):
        if not source_commit:
            source_tree = "unknown"
        started = _utc_now()
        results = [{
            "key": "source-tree",
            "label": "clean committed source tree",
            "status": "failed",
            "exitCode": 2,
            "durationMs": 0,
        }]
        receipt = build_receipt(
            args.profile, results, started_at=started,
            finished_at=_utc_now(), commit=source_commit,
            source_tree=source_tree)
        try:
            write_receipt(args.report.resolve(), receipt)
        except FileExistsError:
            print("Acceptance receipt already exists: " + str(args.report.resolve()))
            return 2
        print("Acceptance receipt: " + str(args.report.resolve()))
        print("\nCOMMERCIAL GATE BLOCKED: source tree is " + source_tree)
        return 1

    started = _utc_now()
    results = execute_plan(plan)
    final_tree = _workspace_state()
    final_commit = _commit()
    if requires_receipt(args.profile) and (
            final_tree != "clean" or final_commit != source_commit):
        source_tree = (final_tree if final_tree != "clean" else "changed")
        results.append({
            "key": "source-tree-after",
            "label": "source tree remained unchanged during acceptance",
            "status": "failed",
            "exitCode": 2,
            "durationMs": 0,
        })
    receipt = build_receipt(args.profile, results, started_at=started,
                            finished_at=_utc_now(), commit=source_commit,
                            source_tree=source_tree)
    if args.report:
        try:
            write_receipt(args.report.resolve(), receipt)
        except FileExistsError:
            print("Acceptance receipt already exists: " + str(args.report.resolve()))
            return 2
        print("Acceptance receipt: " + str(args.report.resolve()))
    print("\nCOMMERCIAL GATE " + receipt["status"].upper())
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
