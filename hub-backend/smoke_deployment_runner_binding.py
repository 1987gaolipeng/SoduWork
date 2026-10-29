"""Offline regression for owner-scoped development and exact deployment Runner binding."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
sys.path.insert(0, ".")

from app.services import environment_service, runner_hub  # noqa: E402


passed = failed = 0


def check(name: str, condition, detail=None) -> None:
    global passed, failed
    if condition:
        passed += 1
        print("PASS", name)
    else:
        failed += 1
        print("FAIL", name, detail if detail is not None else "")


class Runner:
    def __init__(self, runner_id: str, *, org_id: str, tags: list[str], busy: int = 0):
        self.id = runner_id
        self.client_id = ""
        self.org_id = org_id
        self.host = runner_id
        self.tags = tags
        self.agents = []
        self.capabilities = None
        self.dispatch_mode = "accepting"
        self.ready = True
        self.inventory_ready = True
        self.busy = busy
        self.connected_at = time.time()
        self.version = "smoke"

    def alive(self) -> bool:
        return True


def main() -> None:
    selector = environment_service._selector({
        "tags": ["Windows", "build", "build"],
        "runnerIds": ["runner-build-a", "runner-build-a", " runner-build-b "],
    })
    check("selector normalizes tags and preserves exact Runner ids",
          selector == {"tags": ["windows", "build"],
                       "runnerIds": ["runner-build-a", "runner-build-b"]}, selector)

    allowed = Runner("runner-build-a", org_id="deployment-org", tags=["windows", "build"], busy=5)
    same_tag = Runner("runner-build-b", org_id="task-org", tags=["windows", "build"], busy=0)
    saved = dict(runner_hub._RUNNERS)
    original_supports = runner_hub.supports_capabilities
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS.update({allowed.id: allowed, same_tag.id: same_tag})
    runner_hub.supports_capabilities = lambda _runner, _required=None: True
    try:
        picked = runner_hub.pick_by_tags(
            ["windows", "build"], allowed_client_ids=set(),
            allowed_org_ids={"task-org"}, allowed_runner_ids={allowed.id},
            required_capabilities=["repository", "terminal"])
        check("explicit deployment binding selects the configured Runner across task org scope",
              picked is allowed, picked and picked.id)
        check("an equally tagged lower-load Runner cannot steal an explicitly bound deployment",
              picked is not same_tag, picked and picked.id)
        missing = runner_hub.pick_by_tags(
            ["windows", "build"], allowed_client_ids=set(),
            allowed_org_ids={"task-org"}, allowed_runner_ids={"runner-offline"})
        check("an offline explicit Runner fails closed without same-tag fallback", missing is None, missing)
    finally:
        runner_hub.supports_capabilities = original_supports
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS.update(saved)

    workflow = (Path(__file__).resolve().parent / "app/services/workflow_engine.py").read_text(
        encoding="utf-8")
    check("plugin AI execution is scoped to the task owner's current desktop Runner",
          "with_client_runner_scope(ctx, str(task.owner_client_id or \"\"))" in workflow)

    print(f"\ndeployment runner binding smoke: {passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
