"""Replay the synthetic desktop order-cleaning task from issue #1456 on a generated script.

Run: python tools/dev/verify_order_triage.py path/to/triage.py [--report results.json]
The task's command line is: python triage.py input.csv output.json.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

BASE = """order_id,region,amount,currency,date,type,channel
1001,EAST,999.00,CNY,2026-10-01,sale,web
1001,east,120.00,CNY,2026-10-02,sale,web
1002,WEST,20.00,CNY,2026/10/3,REFUND,web
1003,north,10.00,CNY,2026-10-04T09:00:00,sale,web
1004,south,25.00,CNY,2026-10-05,sale,web
1005,east,unknown,CNY,2026-10-05,sale,web
1006,east,25.00,CNY,2026-02-30,sale,web
"""
SALE = "T901,east,￥123.45,CNY,2026-10-05T13:22:10,sale,web,extra"
AMOUNT = "T902,west,{},CNY,2026-10-06,sale,web"
REFUND = "T903,EAST,-50.00,CNY,{},REFUND,web"
SLASH_REFUND = REFUND.format("2026/10/7 09:00:00")
BAD_AMOUNT = (4, 2, 1, "135.00")
BAD_DATE = (4, 1, 2, "135.00")
REGIONS = ["east", "south", "north"]
CASES = [
    ("baseline", [], (4, 1, 1, "135.00")),
    ("nan", [AMOUNT.format("nan")], BAD_AMOUNT),
    ("slash datetime refund", [SLASH_REFUND], (5, 1, 1, "85.00")),
    ("three reported rows", [SALE, AMOUNT.format("nan"), SLASH_REFUND], (6, 2, 1, "208.45")),
    ("positive infinity", [AMOUNT.format("Infinity")], BAD_AMOUNT),
    ("negative infinity", [AMOUNT.format("-inf")], BAD_AMOUNT),
    ("overflow", [AMOUNT.format("1e999")], BAD_AMOUNT),
    ("invalid calendar date", [REFUND.format("2026/2/30 09:00:00")], BAD_DATE),
    ("invalid clock time", [REFUND.format("2026/10/7 25:00:00")], BAD_DATE),
]


def reject_constant(value):
    raise ValueError(f"invalid JSON number {value}")


def check_case(script, name, rows, expected):
    counts = ("valid_orders", "bad_amount", "bad_date")
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        source, output = work / "input.csv", work / "result.json"
        source.write_text(BASE + "".join(row + "\n" for row in rows), encoding="utf-8")
        result = {"case": name, "passed": False, "expected": dict(zip(counts, expected[:3]))}
        result["expected"].update(net_revenue=expected[3], top3_regions=REGIONS)
        try:
            run = subprocess.run([sys.executable, "-I", str(script), str(source), str(output)],
                                 cwd=work, capture_output=True, timeout=20)
            if run.returncode:
                raise ValueError(f"script exited with {run.returncode}")
            if not output.is_file():
                raise ValueError("script did not write the requested output file")
            data = json.loads(output.read_text(encoding="utf-8-sig"), parse_float=Decimal,
                              parse_constant=reject_constant)
            actual_counts = tuple(data[key] for key in counts)
            net, regions = data["net_revenue"], data["top3_regions"]
            result["actual"] = dict(zip(counts, actual_counts))
            result["actual"].update(net_revenue=str(net), top3_regions=regions)
            result["passed"] = (all(type(n) is int for n in actual_counts)
                                and actual_counts == expected[:3]
                                and type(net) in (int, Decimal) and net == Decimal(expected[3])
                                and regions == REGIONS)
        except (KeyError, OSError, TypeError, ValueError, subprocess.TimeoutExpired) as exc:
            result["error"] = str(exc)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("script", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    script = args.script.resolve(strict=True)
    digest = hashlib.sha256(script.read_bytes()).hexdigest()
    cases = [check_case(script, *case) for case in CASES]
    for case in cases:
        if case["passed"]:
            print("PASS", case["case"])
        else:
            detail = case.get("error") or f"expected {case['expected']}, got {case['actual']}"
            print("FAIL", case["case"], detail)
    if args.report:
        report = {"script_sha256": digest, "cases": cases}
        args.report.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    passed = sum(case["passed"] for case in cases)
    print(f"{passed}/{len(cases)} cases passed")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
