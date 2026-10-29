"""Commercial release gate: journeys, fail-closed plans and immutable receipts."""
from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time

from commercial_acceptance_manifest import (
    JOURNEYS,
    REQUIRED_IDS,
    SCHEMA_VERSION,
    audit,
    journey_ids,
)
from commercial_gate import (
    Check,
    _run,
    build_plan,
    build_receipt,
    execute_plan,
    requires_receipt,
    write_receipt,
)
from quality_manifest import GROUPS


ROOT = Path(__file__).resolve().parent
passed = failed = 0


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(detail)[:500] if detail else ""))


errors = audit(ROOT, GROUPS)
check("all commercial evidence is executable and registered", not errors, errors)
check("the baseline covers exactly UJ-01 through UJ-16",
      tuple(JOURNEYS) == REQUIRED_IDS)
check("P0 and P1 have explicit, non-overlapping journey sets",
      len(journey_ids("p0")) == 9 and len(journey_ids("p1")) == 7
      and set(journey_ids("p0")).isdisjoint(journey_ids("p1")))
check("every product-required journey has a real Electron path",
      all(item.get("product") for item in JOURNEYS.values()
          if item.get("productRequired")))
check("every product-required journey has an exact executable marker",
      all(item.get("productMarker") == key for key, item in JOURNEYS.items()
          if item.get("productRequired")))

release = build_plan("release")
candidate = build_plan("candidate", hub="http://example.invalid:8989", cdp_port=9333)
live = build_plan("live")
check("release, candidate and live plans increase assurance explicitly",
      [row.key for row in release] == ["quality"]
      and [row.key for row in candidate] == ["quality", "product-journeys"]
      and [row.key for row in live] == [
          "quality", "product-journeys", "live-integrations"])
check("candidate and live profiles always require immutable receipts",
      not requires_receipt("release") and requires_receipt("candidate")
      and requires_receipt("live"))

calls = []


def failing_runner(item):
    calls.append(item.key)
    return (7 if item.key == "product-journeys" else 0, 12)


results = execute_plan(live, runner=failing_runner)
check("a failed foundation blocks later dependent checks",
      calls == ["quality", "product-journeys"]
      and [row["status"] for row in results] == ["passed", "failed", "skipped"],
      (calls, results))

receipt = build_receipt(
    "live", results, started_at="2026-08-23T00:00:00Z",
    finished_at="2026-08-23T00:00:10Z", commit="a" * 40)
check("a partial run produces a blocked receipt",
      receipt["schemaVersion"] == SCHEMA_VERSION
      and receipt["status"] == "blocked"
      and len(receipt["journeys"]) == 16)
passing_results = [{
    "key": "quality", "label": "quality", "status": "passed",
    "exitCode": 0, "durationMs": 1,
}]
clean_receipt = build_receipt(
    "candidate", passing_results, started_at="2026-08-23T00:00:00Z",
    finished_at="2026-08-23T00:00:01Z", commit="b" * 40,
    source_tree="clean")
dirty_receipt = build_receipt(
    "candidate", passing_results, started_at="2026-08-23T00:00:00Z",
    finished_at="2026-08-23T00:00:01Z", commit="b" * 40,
    source_tree="dirty")
check("candidate receipts pass only for a clean committed source tree",
      clean_receipt["status"] == "passed"
      and dirty_receipt["status"] == "blocked"
      and dirty_receipt["sourceTree"] == "dirty")
serialized = json.dumps(receipt, ensure_ascii=False, sort_keys=True)
check("receipts contain outcomes but never commands, hosts or credentials",
      all(token not in serialized for token in (
          "example.invalid", "--hub", "argv", "PASSWORD", "TOKEN", "API_KEY")))

unsigned = dict(receipt)
fingerprint = unsigned.pop("fingerprint")
canonical = json.dumps(unsigned, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":")).encode("utf-8")
check("receipt fingerprint covers every persisted fact",
      hashlib.sha256(canonical).hexdigest() == fingerprint)

with tempfile.TemporaryDirectory(prefix="soduwork-commercial-receipt-") as directory:
    target = Path(directory) / "candidate.json"
    write_receipt(target, receipt)
    loaded = json.loads(target.read_text(encoding="utf-8"))
    refused = False
    try:
        write_receipt(target, receipt)
    except FileExistsError:
        refused = True
    check("acceptance receipts are valid JSON and cannot be overwritten",
          loaded == receipt and refused)

stream = io.StringIO()
stream_result = {}
stream_check = Check(
    key="stream", label="streaming probe",
    argv=(sys.executable, "-u", "-c",
          "import time; print('soduwork-stream-first 商业门禁', flush=True); "
          "time.sleep(.8); print('soduwork-stream-last', flush=True)"),
    cwd=ROOT, timeout=5)


def run_stream_probe():
    with redirect_stdout(stream):
        stream_result["value"] = _run(stream_check)


worker = threading.Thread(target=run_stream_probe)
worker.start()
stream_deadline = time.monotonic() + 2
while "soduwork-stream-first" not in stream.getvalue() and time.monotonic() < stream_deadline:
    time.sleep(.02)
streamed_early = "soduwork-stream-first" in stream.getvalue() and worker.is_alive()
worker.join(timeout=5)
check("long checks expose progress before the child process finishes",
      streamed_early and not worker.is_alive()
      and stream_result.get("value", (1,))[0] == 0
      and "soduwork-stream-last" in stream.getvalue()
      and "商业门禁" in stream.getvalue(), stream.getvalue())

timeout_output = io.StringIO()
timeout_started = time.monotonic()
with redirect_stdout(timeout_output):
    timeout_code, _ = _run(Check(
        key="timeout", label="timeout probe",
        argv=(sys.executable, "-u", "-c", "import time; time.sleep(30)"),
        cwd=ROOT, timeout=1))
check("timed-out checks stop their process tree promptly",
      timeout_code == 124 and time.monotonic() - timeout_started < 8,
      timeout_output.getvalue())

print(f"\n{passed} PASS / {failed} FAIL")
raise SystemExit(1 if failed else 0)
