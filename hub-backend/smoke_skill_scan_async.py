"""Skill catalog async/cache regression checks (no database, no subprocesses)."""
from __future__ import annotations

import asyncio
import sys
import threading

sys.path.insert(0, ".")

from app.services import skills as SK  # noqa: E402


passed = failed = 0


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("PASS", name)
    else:
        failed += 1
        print("FAIL", name, detail)


async def main() -> None:
    real_scan = SK.scan
    calls: list[tuple[tuple[str, ...], str]] = []
    started = threading.Event()
    release = threading.Event()

    def slow_scan(extra_roots=None, owner_client_id=""):
        calls.append((tuple(extra_roots or []), str(owner_client_id or "")))
        started.set()
        release.wait(2)
        return [{"name": "demo", "path": "C:/demo", "description": "demo"}]

    SK.clear_scan_cache()
    SK.scan = slow_scan
    try:
        first = asyncio.create_task(SK.scan_async(["root-a"], "owner-a"))
        second = asyncio.create_task(SK.scan_async(["root-a"], "owner-a"))
        for _ in range(50):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.02)
        check("slow scan started", started.is_set())
        check("event loop stays responsive while filesystem scan waits",
              started.is_set() and not first.done())

        release.set()
        rows1, rows2 = await asyncio.gather(first, second)
        check("concurrent identical requests scan once", len(calls) == 1, calls)
        check("both callers receive the catalog", rows1 == rows2 and rows1[0]["name"] == "demo")

        rows1[0]["name"] = "mutated"
        cached = await SK.scan_async(["root-a"], "owner-a")
        check("cache returns defensive copies", cached[0]["name"] == "demo", cached)
        check("fresh cache avoids another scan", len(calls) == 1, calls)

        await SK.scan_async(["root-b"], "owner-a")
        check("different roots use a different cache key", len(calls) == 2, calls)
        await SK.scan_async(["root-b"], "owner-a", force=True)
        check("force refresh bypasses a fresh cache entry", len(calls) == 3, calls)
        await SK.scan_async(["root-b"], "owner-b")
        check("personal catalogs are isolated by owner", len(calls) == 4, calls)
    finally:
        SK.scan = real_scan
        SK.clear_scan_cache()


asyncio.run(main())
print(f"PASS={passed} FAIL={failed}")
raise SystemExit(1 if failed else 0)
