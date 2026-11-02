"""Classify inventory against the authenticated client instance, never a hostname."""
from collections.abc import Mapping


def scope_for(client, runner):
    """Return an explicit personal scope, or empty for an unrelated environment.

    This is a presentation boundary. Callers retain their existing authorization
    checks and must never use a display label to infer a current-device route.
    """
    if isinstance(runner, Mapping):
        client_id = str(runner.get("clientId") or "")
        owner_id = str(runner.get("ownerUserId") or "")
        embedded = runner.get("embedded") is True
    else:
        from .runner_hub import is_client_runtime
        client_id = str(getattr(runner, "client_id", "") or "")
        owner_id = str(getattr(runner, "owner_user_id", "") or "")
        embedded = is_client_runtime(runner)
    caller_id = str(getattr(client, "id", "") or "")
    user_id = str(getattr(client, "user_ref", "") or "")
    if client_id:
        if not caller_id or client_id != caller_id:
            return ""
        if owner_id and owner_id != user_id:
            return ""
        return "current-instance" if embedded else "bound-runner"
    if user_id and owner_id == user_id:
        return "personal-cloud"
    return ""
