"""Runtime bridge between pure execution-policy checks and a live CLI process."""
from __future__ import annotations

import threading

from . import execution_policy
from .local_base import _LOCK, _RUNS, _THREADS, _save_meta


def enforce(ref: str, message: dict | None, rendered: list[dict], kill_tree) -> list[dict]:
    """Inspect one CLI JSONL message and stop the process on the first violation."""
    candidates = execution_policy.command_events(message)
    if not candidates:
        candidates = [item for item in rendered if item.get("kind") == "do"]
    violation = None
    with _LOCK:
        run = _RUNS.get(ref)
        if run is None or run.get("executionPolicyViolation"):
            return []
        state = run.setdefault("executionPolicyState", {})
        for item in candidates:
            violation = execution_policy.inspect(item, run.get("executionPolicy"), state)
            if violation:
                run["executionPolicyViolation"] = violation
                run["failureKind"] = "execution_policy"
                run["stopping"] = True
                run["queue"] = []
                break
    if not violation:
        return []
    _save_meta(ref)
    thread = threading.Thread(
        target=kill_tree, args=(ref,), name="ai_local:policy:" + ref[:8], daemon=True)
    _THREADS.add(thread)
    thread.start()
    return [{"kind": "out", "tool": "SoduWork 执行门禁",
             "text": "已阻止本步：" + str(violation.get("reason") or "违反节点执行策略")[:500]}]
