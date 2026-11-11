"""Regression checks for public module contracts."""
from __future__ import annotations

import asyncio
import sys
from unittest.mock import AsyncMock, patch

sys.path.insert(0, ".")

from app.services import runner_release, update_nudges  # noqa: E402

passed = failed = 0


def ok(cond, name, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


async def main() -> int:
    update_nudges.reset_for_test()
    sent: list = []

    async def fake_publish(cid, payload):
        sent.append((cid, payload))

    with patch("app.realtime.hub.publish", new=AsyncMock(side_effect=fake_publish)):
        # Do not notify for matching or unknown versions.
        ok(not await update_nudges.nudge_stale_runner("c1", runner_release.RUNNER_VERSION, "A"),
           "版本一致不提醒")
        ok(not await update_nudges.nudge_stale_runner("c1", "", "A"), "版本未知不提醒")
        ok(not await update_nudges.nudge_stale_runner("", "1.8.8", "A"), "没有归属设备不提醒")

        # Notify once for an outdated version and throttle repeats within the window.
        first = await update_nudges.nudge_stale_runner("c1", "1.8.8", "DESKTOP-FIXTURE", now=1000.0)
        second = await update_nudges.nudge_stale_runner("c1", "1.8.8", "DESKTOP-FIXTURE", now=2000.0)
        ok(first and not second and len(sent) == 1, "过旧提醒一次后同窗口节流", (first, second, sent))
        text = sent[0][1]["text"]
        ok("DESKTOP-FIXTURE" in text and "1.8.8" in text
           and runner_release.RUNNER_VERSION in text and "升级" in text,
           "话术带机器名、当前/目标版本与升级指引", text)

        # Throttle per device, allow later reminders, and explain missing receipts for healed sessions.
        third = await update_nudges.nudge_stale_runner("c2", "1.7.0", "B", now=2000.0)
        fourth = await update_nudges.nudge_stale_runner(
            "c1", "1.8.8", "DESKTOP-FIXTURE", healed=True, now=1000.0 + 7 * 3600)
        ok(third and fourth and len(sent) == 3, "按设备节流、窗口滚动后可再提醒", sent)
        ok("回执" in sent[-1][1]["text"], "接回场景说明回执丢失因果", sent[-1][1]["text"])

        # Notification failure must not propagate to the caller.
        with patch("app.realtime.hub.publish", new=AsyncMock(side_effect=RuntimeError("down"))):
            update_nudges.reset_for_test()
            quiet = await update_nudges.nudge_stale_runner("c3", "1.8.8", "C")
            ok(quiet is False, "推送失败静默降级不抛异常")

    # Verify client upgrade reminders when a device connects to Hub.
    update_nudges.reset_for_test()
    sent.clear()
    with patch("app.realtime.hub.publish", new=AsyncMock(side_effect=fake_publish)):
        ok(await update_nudges.nudge_stale_client("d1", "1.2.0", "1.12.2", now=1000.0),
           "老客户端连上来提醒升级")
        ok("1.2.0" in sent[-1][1]["text"] and "1.12.2" in sent[-1][1]["text"]
           and "手动" in sent[-1][1]["text"],
           "话术带当前/最新版本与『这次要手动装』的说明", sent[-1][1]["text"])
        ok(not await update_nudges.nudge_stale_client("d1", "1.2.0", "1.12.2", now=2000.0),
           "24 小时内不重复提醒")
        ok(await update_nudges.nudge_stale_client("d1", "1.2.0", "1.12.2",
                                                  now=1000.0 + 25 * 3600),
           "窗口过了再提醒")
        ok(not await update_nudges.nudge_stale_client("d2", "1.12.2", "1.12.2"),
           "已是最新不提醒")
        ok(not await update_nudges.nudge_stale_client("d3", "", "1.12.2"),
           "版本报不上来不瞎提醒")
        ok(not await update_nudges.nudge_stale_client("d4", "1.2.0", ""),
           "OTA 通道还没有版本时不提醒")
        # Compare version components numerically: 1.12.1 is newer than 1.2.9.
        ok(await update_nudges.nudge_stale_client("d5", "1.2.9", "1.12.1"),
           "版本比较按数值不按字符串（1.2.9 < 1.12.1）")

    print(f"update nudges smoke: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
