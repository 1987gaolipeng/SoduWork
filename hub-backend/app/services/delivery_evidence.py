"""Shared publication and verification evidence contracts."""
from . import workflow_contracts


EVIDENCE = {
    "review": ("verdict", "change", "patchset", "reportChecksum"),
    "publish": ("customer", "version", "deployStatus", "steps"),
    "verify": ("checks",),
}


def require_evidence(kind: str, output: dict) -> dict:
    """Require all declared evidence fields before success. This checks presence, not validity;
    upstream validators establish correctness. Boolean False is a valid conclusion, not missing
    evidence.
    """
    missing = [key for key in EVIDENCE.get(kind, ())
               if (output or {}).get(key) in (None, "", [], {})]
    if missing:
        raise workflow_contracts.WorkflowContractError(
            "「%s」这一关的证据不齐（缺 %s），按留证规矩不算通过"
            % (kind, "、".join(missing)))
    return output
