# -*- coding: utf-8 -*-
"""Runner adaptive admission: pure in-memory tests, no DB and no Agent spend."""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

sys.path.insert(0, ".")

from app.services import runner_admission as admission  # noqa: E402


passed = failed = 0
lines: list[str] = []


def chk(name: str, condition, extra="") -> None:
    global passed, failed
    if condition:
        passed += 1
        lines.append("  PASS  " + name)
    else:
        failed += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:500] if extra else ""))


def submit(queue, key, ref, category, cli="pi"):
    return queue.submit(key, ref, category, "dispatch", {
        "op": "job.dispatch", "cli": cli, "dispatchId": key,
        "task": {"id": key, "source": "smoke"}, "ctx": {},
    })


def test_unlimited_conversations_and_task_boundary() -> None:
    conversations = admission.AdmissionQueue(task_capacity=100)
    accepted = [submit(conversations, "chat-%03d" % index, "ref-%03d" % index,
                       admission.INTERACTIVE)[0] for index in range(150)]
    metrics = conversations.metrics()
    chk("会话·连续 150 个会话消息全部接收且不受后台容量限制",
        all(accepted) and metrics["queuedConversations"] == 150, metrics)

    tasks = admission.AdmissionQueue(task_capacity=100)
    receipts = [submit(tasks, "task-%03d" % index, "task-ref-%03d" % index,
                       admission.MANUAL) for index in range(100)]
    overflow = submit(tasks, "task-101", "task-ref-101", admission.MANUAL)
    chk("任务·前 100 项全部运行或排队，第 101 项得到明确容量结果",
        all(row[0] for row in receipts) and overflow[0] is False
        and overflow[1] == "capacity"
        and tasks.metrics()["taskOutstanding"] == 100, tasks.metrics())


def test_priority_serial_and_reserved_slot() -> None:
    queue = admission.AdmissionQueue()
    submit(queue, "auto", "auto-ref", admission.AUTOMATION)
    submit(queue, "manual", "manual-ref", admission.MANUAL)
    submit(queue, "chat", "chat-ref", admission.INTERACTIVE)
    claimed = []
    for active in range(3):
        item = queue.claim_next(active, 4, True)
        claimed.append(item.key if item else "")
    chk("优先级·交互会话优先于普通任务，普通任务优先于定时自动化",
        claimed == ["chat", "manual", "auto"], claimed)

    serial = admission.AdmissionQueue()
    submit(serial, "turn-1", "same-session", admission.INTERACTIVE)
    submit(serial, "turn-2", "same-session", admission.INTERACTIVE)
    first = serial.claim_next(0, 2, True)
    blocked = serial.claim_next(1, 2, True)
    serial.finish(first.key, "completed")
    second = serial.claim_next(0, 2, True)
    chk("顺序·同一会话严格串行且下一轮只在上一轮完成后启动",
        first and first.key == "turn-1" and blocked is None
        and second and second.key == "turn-2")

    reserved = admission.AdmissionQueue()
    for index in range(3):
        submit(reserved, "background-%d" % index, "bg-%d" % index, admission.MANUAL)
    bg1 = reserved.claim_next(0, 3, True)
    bg2 = reserved.claim_next(1, 3, True)
    held = reserved.claim_next(2, 3, True)
    submit(reserved, "urgent-chat", "urgent-chat-ref", admission.INTERACTIVE)
    chat = reserved.claim_next(2, 3, True)
    chk("调度·后台工作不能占满机器，至少保留一个交互槽",
        bg1 and bg2 and held is None and chat and chat.key == "urgent-chat")

    mixed = admission.AdmissionQueue()
    submit(mixed, "turn-active", "one-session", admission.INTERACTIVE)
    active_turn = mixed.claim_next(0, 3, True)
    submit(mixed, "turn-next", "one-session", admission.INTERACTIVE)
    submit(mixed, "other-task", "other-ref", admission.MANUAL)
    unrelated = mixed.claim_next(1, 3, True)
    chk("调度·同会话后续消息等待时不冻结其他会话或后台任务",
        active_turn and active_turn.key == "turn-active"
        and unrelated and unrelated.key == "other-task")


def test_resource_budget_and_queue_recovery() -> None:
    gib = 1024 ** 3
    floor = 768 * 1024 ** 2
    sample = {"cpuCount": 16}
    budget = admission.AdaptiveResourceBudget(sampler=lambda: sample)
    now = 100.0

    def snapshot(cpu, available, total, elapsed=1.0, force=True):
        nonlocal now
        now += elapsed
        sample.update(cpuPercent=cpu, memoryAvailableBytes=available, memoryTotalBytes=total)
        with patch.object(admission.time, "monotonic", return_value=now):
            return budget.snapshot(force=force)

    queue = admission.AdmissionQueue()
    first = submit(queue, "first", "one", admission.MANUAL)[2]
    second = submit(queue, "second", "two", admission.MANUAL)[2]
    busy = snapshot(94.9, 8 * gib, 16 * gib)
    chk("资源·CPU 低于 95% 时保留原有的自适应并发", busy.pressure == "busy" and busy.can_start
        and busy.limit > 1, busy.public())
    spike = snapshot(95, 8 * gib, 16 * gib)
    cached = snapshot(95, 8 * gib, 16 * gib, elapsed=0.25, force=False)
    early = snapshot(100, 8 * gib, 16 * gib, elapsed=0.25)
    chk("资源·单次 CPU 峰值和一秒内的重复采样均暂停启动",
        spike.pressure == "critical" and not spike.can_start and not cached.can_start and not early.can_start)
    serial = snapshot(95, 8 * gib, 16 * gib, elapsed=0.5)
    chk("资源·CPU 持续达到 95% 时只启动一项，其余等待执行槽",
        serial.pressure == "critical" and serial.limit == 1 and serial.can_start
        and queue.claim_next(0, serial.limit, serial.can_start) is first
        and queue.claim_next(1, serial.limit, serial.can_start) is None
        and queue.wait_reason(second, 1, serial.limit, serial.can_start) == "execution_slot",
        serial.public())
    for cpu in (100, 20):
        for label, available, total in (("内存占用达到 92%", 2 * gib, 25 * gib),
                                        ("可用内存低于 768 MiB", floor - 1, 4 * gib)):
            blocked = snapshot(cpu, available, total)
            chk(f"资源·CPU {cpu}% 且{label}时阻止启动并报告等待原因",
                blocked.pressure == "critical" and blocked.limit == 1 and not blocked.can_start
                and queue.claim_next(0, blocked.limit, blocked.can_start) is None
                and queue.wait_reason(second, 0, blocked.limit, blocked.can_start) == "resource_pressure",
                blocked.public())
        if cpu == 100:
            chk("资源·持续高 CPU 时缺少可用内存读数仍暂停启动", not snapshot(cpu, 0, 0).can_start)
            chk("资源·内存恢复且 CPU 仍饱和时重新允许串行启动",
                snapshot(cpu, floor, 4 * gib).can_start)
    chk("资源·内存刚好脱离任一临界阈值时允许启动",
        snapshot(20, 2 * gib + 1, 25 * gib).can_start and snapshot(20, floor, 4 * gib).can_start)
    chk("资源·CPU 降至阈值以下后需重新观察下一次峰值", not snapshot(100, 8 * gib, 16 * gib).can_start)
    recovered = snapshot(25, 12 * gib, 16 * gib)
    chk("资源·压力恢复后清除等待原因并启动下一项",
        recovered.can_start and recovered.pressure == "normal" and 1 < recovered.limit <= 20
        and not queue.wait_reason(second, 1, recovered.limit, recovered.can_start)
        and queue.claim_next(1, recovered.limit, recovered.can_start) is second, recovered.public())


def test_cancel_idempotency_and_substrates() -> None:
    queue = admission.AdmissionQueue()
    submit(queue, "cancel-me", "cancel-ref", admission.INTERACTIVE)
    mode, item, payload = queue.cancel_ref("cancel-ref")
    chk("取消·排队消息可以独立取消并归一为 cancelled",
        mode == "cancelled" and item.state == "cancelled"
        and payload and admission.status_data(item)["state"] == "cancelled")
    chk("停止·真实 local_stream stopped 归一为 cancelled 而不是 failed",
        admission.standard_state("stopped") == "cancelled")
    duplicate = submit(queue, "cancel-me", "cancel-ref", admission.INTERACTIVE)
    chk("幂等·终态消息重送仍返回原结果而不是再启动一份",
        duplicate[0] and duplicate[1] == "duplicate"
        and duplicate[2] is item and duplicate[2].state == "cancelled")

    clis = ["pi", "codex-harness", "codex", "opencode",
            "claude", "qwen", "deepseek-harness"]
    substrate_queue = admission.AdmissionQueue()
    rows = [submit(substrate_queue, "chat-" + cli, "ref-" + cli,
                   admission.INTERACTIVE, cli) for cli in clis]
    chk("底座·七类 Agent 共用同一调度协议且会话均可接收",
        all(row[0] and row[2].category == admission.INTERACTIVE for row in rows), rows)

    for state, launched in (("cancelled", False), ("failed", False), ("cancelled", True), ("failed", True)):
        pending = admission.AdmissionQueue()
        _, _, turn = pending.submit("follow-up", "existing", admission.INTERACTIVE, "comment", {})
        if launched:
            pending.claim_next(0, 1, True)
            pending.mark_running(turn.key, {"ok": True})
        pending.finish(turn.key, state, "preflight failed" if state == "failed" else "")
        chk("续轮·%s %s 保持正确状态权威" % ("已启动" if launched else "未启动", state),
            admission.owns_status(turn, True) == (not launched)
            and admission.owns_status(turn, False))


def main() -> int:
    test_unlimited_conversations_and_task_boundary()
    test_priority_serial_and_reserved_slot()
    test_resource_budget_and_queue_recovery()
    test_cancel_idempotency_and_substrates()
    print("\n".join(lines))
    print("\nRunner admission: %d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
