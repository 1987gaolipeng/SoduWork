"""Existing task dispatch previews must use the task's frozen capability contract."""
import os
import sys
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
sys.path.insert(0, ".")

from app.services import task_execution_options as options  # noqa: E402
from app.services import work_catalog  # noqa: E402


frozen = SimpleNamespace(
    work_routing={
        "requiredAgentCapabilities": ["computer"],
        "requiredSkills": ["computer-use"],
    },
    work_scenario_key="scheduled-local-review",
    work_scenario_name="Local review",
)

resolved = options._routing_for_task(
    frozen, {"requiredAgentCapabilities": []})
assert resolved["requiredAgentCapabilities"] == ["computer"], resolved
assert resolved["requiredSkills"] == ["computer-use"], resolved
assert resolved["scenarioKey"] == "scheduled-local-review", resolved
assert resolved["scenarioName"] == "Local review", resolved

original = work_catalog.routing_snapshot
work_catalog.routing_snapshot = lambda _item: {
    "requiredAgentCapabilities": ["browser"]}
try:
    fresh = options._routing_for_task(None, {})
finally:
    work_catalog.routing_snapshot = original
assert fresh["requiredAgentCapabilities"] == ["browser"], fresh

print("task frozen routing: 5 assertions green")
