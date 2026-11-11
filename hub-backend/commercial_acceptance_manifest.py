"""Machine-readable commercial user-journey coverage for SoduWork releases."""
from __future__ import annotations

from pathlib import Path
from typing import Mapping, Sequence

from product_coverage_manifest import ROLE_COVERAGE
from public_source import is_public_snapshot


SCHEMA_VERSION = "soduwork.commercial-acceptance/1.0"
REQUIRED_IDS = tuple(f"UJ-{index:02d}" for index in range(1, 17))


JOURNEYS = {
    "UJ-01": {
        "tier": "p0", "label": "Employee opens SoduWork and can work",
        "roles": ("office_worker",), "productRequired": True,
        "deterministic": ("../client/tests/desktop-entry.test.cjs",
                          "../client/tests/commercial-ui-truth.test.cjs"),
        "product": ("../client/e2e/user-journeys.mjs",), "live": (),
        "productMarker": "UJ-01",
    },
    "UJ-02": {
        "tier": "p0", "label": "Conversation works without forcing a task",
        "roles": ("office_worker",), "productRequired": True,
        "deterministic": ("smoke/smoke_conversation_ui.py",),
        "product": ("../client/e2e/user-journeys.mjs",),
        "live": ("smoke/smoke_ai_proxy.py",),
        "productMarker": "UJ-02",
    },
    "UJ-03": {
        "tier": "p0", "label": "Conversation can be promoted to one task",
        "roles": ("requester", "task_owner"), "productRequired": True,
        "deterministic": ("smoke/smoke_conversation_ui.py", "smoke/smoke_task_commands.py"),
        "product": ("../client/e2e/user-journeys.mjs",), "live": (),
        "productMarker": "UJ-03",
    },
    "UJ-04": {
        "tier": "p0", "label": "Create and track a normal task",
        "roles": ("task_owner",), "productRequired": True,
        "deterministic": ("smoke/smoke_task_commands.py", "smoke/smoke_task_trace.py"),
        "product": ("../client/e2e/user-journeys.mjs",), "live": (),
        "productMarker": "UJ-04",
    },
    "UJ-05": {
        "tier": "p0", "label": "People and AI can hand work to each other",
        "roles": ("task_owner", "team_lead", "ai_executor"),
        "productRequired": True,
        "deterministic": ("smoke/smoke_task_transfer.py", "smoke/smoke_handoff.py",
                          "smoke/smoke_current_device_dispatch.py"),
        "product": ("../client/e2e/user-journeys.mjs",), "live": (),
        "productMarker": "UJ-05",
    },
    "UJ-06": {
        "tier": "p0", "label": "AI work progress is understandable",
        "roles": ("task_owner", "ai_executor", "runner_executor"),
        "productRequired": True,
        "deterministic": ("smoke/smoke_aidesk.py", "smoke/smoke_task_trace.py"),
        "product": ("../client/e2e/user-journeys.mjs",),
        "live": ("smoke/smoke_execution_live.py",),
        "productMarker": "UJ-06",
    },
    "UJ-07": {
        "tier": "p0", "label": "Humans decide only at governed gates",
        "roles": ("project_owner", "release_authorizer", "business_acceptor"),
        "productRequired": True,
        "deterministic": ("smoke/smoke_gate_contract.py", "smoke/smoke_golden_delivery.py"),
        "product": ("../client/e2e/user-journeys.mjs",),
        "live": ("smoke/smoke_approvals.py",),
        "productMarker": "UJ-07",
    },
    "UJ-08": {
        "tier": "p0", "label": "Daily and weekly briefs are employee features",
        "roles": ("office_worker", "team_lead"), "productRequired": True,
        "deterministic": ("smoke/smoke_team_daily_report.py", "smoke/smoke_work_reports.py"),
        "product": ("../client/e2e/user-journeys-catalog.mjs",), "live": (),
        "productMarker": "UJ-08",
    },
    "UJ-09": {
        "tier": "p0", "label": "Interrupted work recovers without duplication",
        "roles": ("task_owner", "runner_executor", "runner_admin"),
        "productRequired": True,
        "deterministic": ("smoke/smoke_dispatch_reconcile.py",
                          "smoke/smoke_dispatch_reliability.py",
                          "smoke/smoke_execution_sessions.py"),
        "product": ("../client/e2e/user-journeys.mjs",),
        "live": ("smoke/smoke_runner_job.py",),
        "productMarker": "UJ-09",
    },
    "UJ-10": {
        "tier": "p1", "label": "Requirement becomes a repository delivery",
        "roles": ("requester", "software_engineer", "ai_executor"),
        "productRequired": False,
        "deterministic": ("smoke/smoke_golden_delivery.py", "smoke/smoke_repository_assets.py"),
        "product": (), "live": ("smoke/smoke_live_push.py",),
    },
    "UJ-11": {
        "tier": "p1", "label": "Independent AI performs code review",
        "roles": ("ai_reviewer", "project_owner"), "productRequired": False,
        "deterministic": ("smoke/smoke_ai_review.py",), "product": (), "live": (),
    },
    "UJ-12": {
        "tier": "p1", "label": "Approved code merges automatically and once",
        "roles": ("workflow_engine", "project_owner"), "productRequired": False,
        "deterministic": ("smoke/smoke_merge_reauth.py", "smoke/smoke_golden_delivery.py"),
        "product": (), "live": ("smoke/smoke_live_push.py",),
    },
    "UJ-13": {
        "tier": "p1", "label": "Authorized release ends in human acceptance",
        "roles": ("release_authorizer", "business_acceptor"),
        "productRequired": False,
        "deterministic": ("smoke/smoke_gate_contract.py", "smoke/smoke_golden_delivery.py"),
        "product": (), "live": ("smoke/smoke_live_push.py",),
    },
    "UJ-14": {
        "tier": "p1", "label": "Environment chains are configurable",
        "roles": ("environment_admin",), "productRequired": False,
        "deterministic": ("smoke/smoke_environment_config.py",),
        "product": (), "live": ("smoke/smoke_runner_management_live.py",),
    },
    "UJ-15": {
        "tier": "p1", "label": "Failed delivery is retryable and reversible",
        "roles": ("environment_admin", "delivery_operator"),
        "productRequired": False,
        "deterministic": ("smoke/smoke_rollback.py", "smoke/smoke_delivery_truth.py"),
        "product": (), "live": (),
    },
    "UJ-16": {
        "tier": "p1", "label": "Workflow plugins are portable and governed",
        "roles": ("workflow_plugin_admin", "workflow_engine"),
        "productRequired": False,
        "deterministic": ("smoke/smoke_plugin_governance.py", "smoke/smoke_plugin_ready.py"),
        "product": (), "live": ("smoke/smoke_plugin_e2e.py",),
    },
}


if is_public_snapshot():
    JOURNEYS["UJ-15"]["label"] = "Delivery evidence is retained and missing private rollback fails explicitly"
    JOURNEYS["UJ-15"]["deterministic"] = ("test_optional_services.py", "smoke/smoke_delivery_truth.py")


def journey_ids(tier: str | None = None) -> tuple[str, ...]:
    return tuple(key for key, item in JOURNEYS.items()
                 if tier is None or item.get("tier") == tier)


def audit(root: Path, groups: Mapping[str, Sequence[str]]) -> list[str]:
    """Reject paper coverage that is absent from the executable quality tiers."""
    errors: list[str] = []
    if tuple(JOURNEYS) != REQUIRED_IDS:
        errors.append("commercial journeys must be exactly UJ-01 through UJ-16")
    offline = set(groups.get("release", ())) | set(groups.get("extended", ()))
    live = set(groups.get("live", ()))
    for journey_id, item in JOURNEYS.items():
        if item.get("tier") not in {"p0", "p1"}:
            errors.append(f"{journey_id} has an invalid tier")
        roles = tuple(item.get("roles") or ())
        missing_roles = sorted(set(roles) - set(ROLE_COVERAGE))
        if not roles or missing_roles:
            errors.append(f"{journey_id} has invalid roles: {missing_roles}")
        deterministic = tuple(item.get("deterministic") or ())
        product = tuple(item.get("product") or ())
        live_rows = tuple(item.get("live") or ())
        product_marker = str(item.get("productMarker") or "")
        if not deterministic:
            errors.append(f"{journey_id} has no deterministic evidence")
        if item.get("productRequired") and not product:
            errors.append(f"{journey_id} requires a real product journey")
        if item.get("productRequired") and product_marker != journey_id:
            errors.append(f"{journey_id} has no exact product marker")
        for name in deterministic:
            path = (root / name).resolve()
            if not path.is_file():
                errors.append(f"{journey_id} evidence does not exist: {name}")
            if name.endswith(".py") and name not in offline:
                errors.append(f"{journey_id} deterministic smoke is not in an offline gate: {name}")
        for name in product:
            path = (root / name).resolve()
            if not path.is_file():
                errors.append(f"{journey_id} product journey does not exist: {name}")
            elif product_marker:
                source = path.read_text(encoding="utf-8")
                single = "journey('" + product_marker + "'"
                double = 'journey("' + product_marker + '"'
                if single not in source and double not in source:
                    errors.append(f"{journey_id} product marker is not executable")
        for name in live_rows:
            if not (root / name).resolve().is_file():
                errors.append(f"{journey_id} live evidence does not exist: {name}")
            if name.endswith(".py") and name not in live:
                errors.append(f"{journey_id} live smoke is not in the live gate: {name}")
    if not any(item.get("product") for item in JOURNEYS.values()):
        errors.append("commercial coverage has no real Electron journey")
    return errors
