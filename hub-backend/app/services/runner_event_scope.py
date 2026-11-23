"""Trusted Runner routing metadata and conservative desktop archive attribution."""
from .dispatch_identity import execution_ref


def ingress(message: dict, *, local: bool) -> dict:
    """Set private routing only at the authenticated transport boundary."""
    clean = dict(message)
    for key in ("_localParent", "_admitted", "_admissionKey", "_eventDestination"):
        clean.pop(key, None)
    clean["_eventDestination"] = "local" if local else "hub"
    if local:
        clean["_localParent"] = True
    return clean


def is_local(run: dict, ref: str) -> bool:
    destination = run.get("eventDestination")
    if "eventDestination" in run:
        return destination == "local"
    task_id, cli = str(run.get("taskId") or ""), str(run.get("cli") or "")
    return bool(task_id.startswith("chat-") and cli and ref and
                execution_ref("chat:" + task_id + ":" + cli) == ref)


def payload_destination(payload: dict) -> str:
    """Interpret trusted queue payloads, including pre-routing local pipe records.

    Network ingress strips the private parent marker before journaling. Only
    records predating explicit routing may use that persisted marker as evidence.
    """
    if "_eventDestination" in payload:
        return "local" if payload["_eventDestination"] == "local" else "hub"
    return "local" if (payload.get("_localParent") is True and
                       payload.get("op") == "job.dispatch") else "hub"


def restore_destination(run: dict, ref: str) -> bool:
    """Freeze proven legacy ownership before a later runtime switch changes CLI."""
    if "eventDestination" in run or not is_local(run, ref):
        return False
    run["eventDestination"] = "local"
    return True


def local_bindings(runs: dict[str, dict]) -> dict[str, str]:
    return {ref: str(run["taskId"]) for ref, run in runs.items()
            if run.get("taskId") and is_local(run, ref)}
