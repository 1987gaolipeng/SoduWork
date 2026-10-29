"""Shared schedule request and response contract for both authorization views.

Authorization and owner selection remain in each router. Timestamp formatting is
provided by the caller to preserve the existing tolerant personal view.
"""
from fastapi import HTTPException


def schedule_payload(s, *, timestamp, administrative=False) -> dict:
    from ..services import schedules as sch
    next_at = sch.next_run_instant(s, s.last_run_at)
    next_local = next_at.astimezone(sch.schedule_zone(s)) if next_at else None
    payload = {"id": s.id, "title": s.title, "note": s.note, "every": s.every,
            "runAt": timestamp(getattr(s, "run_at", None)),
            "onceFired": bool(getattr(s, "once_fired", False)),
            "atHour": s.at_hour, "atMinute": s.at_minute, "weekday": s.weekday,
            "timeZone": sch.clean_time_zone(s.time_zone),
            "assigneeId": s.assignee_id, "assigneeType": s.assignee_type,
            "repoId": s.repo_id, "flow": bool(s.flow), "enabled": bool(s.enabled),
            "pluginBindingId": s.plugin_binding_id,
            "personalPluginKey": str(getattr(s, "personal_plugin_key", "") or ""),
            "personalPluginVersionPolicy": str(getattr(
                s, "personal_plugin_version_policy", "") or "latest"),
            "personalPluginVersion": str(getattr(s, "personal_plugin_version", "") or ""),
            "personalPluginChecksum": str(getattr(
                s, "personal_plugin_checksum", "") or ""),
            "pluginInputs": dict(s.plugin_inputs or {}),
            "executionMode": ("plugin" if s.plugin_binding_id
                              else "personal" if getattr(s, "personal_plugin_key", "")
                              else "direct"),
            "requiredCapabilities": list(s.required_capabilities or []),
            "retryLimit": int(s.retry_limit or 0),
            "retryDelayMinutes": int(s.retry_delay_minutes or 5),
            "retryCount": int(s.retry_count or 0),
            "nextRetryAt": timestamp(s.next_retry_at),
            "retrying": bool(s.next_retry_at),
            "lastRunAt": timestamp(s.last_run_at), "lastTaskId": s.last_task_id,
            "lastError": s.last_error,
            "nextRunAt": timestamp(next_at),
            "nextRunLocal": next_local.strftime("%Y-%m-%d %H:%M") if next_local else ""}

    if administrative:
        payload.update(ownerClientId=s.owner_client_id, createdByName=s.created_by_name)
    return payload


def apply_schedule_update(s, body: dict) -> None:
    """Apply only supplied schedule fields after validating their shape and length."""
    from ..services import schedules as sch, schedule_timing
    once_edit = getattr(s, "every", "") == "once" or body.get("every") == "once"
    before_execution = schedule_timing.execution_snapshot(s) if once_edit else None
    if "title" in body:
        s.title = str(body.get("title") or "").strip()[:200]
    if "note" in body:
        from ..services.conversation_turns import execution_instruction
        s.note = execution_instruction(body.get("note"))
    if "atHour" in body:
        s.at_hour = max(0, min(23, int(body.get("atHour") or 0)))
    if "atMinute" in body:
        s.at_minute = max(0, min(59, int(body.get("atMinute") or 0)))
    if "weekday" in body:
        s.weekday = max(1, min(7, int(body.get("weekday") or 1)))
    if "timeZone" in body:
        s.time_zone = sch.clean_time_zone(body.get("timeZone"))
    for k, f in (("assigneeId", "assignee_id"), ("assigneeType", "assignee_type"),
                 ("repoId", "repo_id"), ("ownerClientId", "owner_client_id")):
        if k in body:
            setattr(s, f, str(body.get(k) or "").strip()[:64])
    if "flow" in body:
        s.flow = bool(body.get("flow"))
    if "pluginBindingId" in body:
        s.plugin_binding_id = str(body.get("pluginBindingId") or "").strip()[:36]
    if "personalPluginKey" in body:
        # Normalize shape here; validate_execution handles patterns, exclusions, and executors with HTTP 409 errors.
        s.personal_plugin_key = str(body.get("personalPluginKey") or "").strip()[:64]
        if not s.personal_plugin_key:
            s.personal_plugin_version_policy = "latest"
            s.personal_plugin_version = ""
            s.personal_plugin_checksum = ""
    if "personalPluginVersionPolicy" in body:
        s.personal_plugin_version_policy = str(
            body.get("personalPluginVersionPolicy") or "latest").strip().lower()[:16]
    if "personalPluginVersion" in body:
        s.personal_plugin_version = str(body.get("personalPluginVersion") or "").strip()[:40]
    if "personalPluginChecksum" in body:
        s.personal_plugin_checksum = str(
            body.get("personalPluginChecksum") or "").strip().lower()[:64]
    # Hidden form fields can be stale after clearing the plugin selector.
    # An empty key always means there is no personal-plugin snapshot.
    if not str(getattr(s, "personal_plugin_key", "") or ""):
        s.personal_plugin_version_policy = "latest"
        s.personal_plugin_version = ""
        s.personal_plugin_checksum = ""
    if "pluginInputs" in body:
        try:
            s.plugin_inputs = sch.clean_plugin_inputs(body.get("pluginInputs"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if "requiredCapabilities" in body:
        s.required_capabilities = sch.clean_required_capabilities(
            body.get("requiredCapabilities"))
    if "retryLimit" in body:
        s.retry_limit = max(0, min(10, int(body.get("retryLimit") or 0)))
    if "retryDelayMinutes" in body:
        s.retry_delay_minutes = max(
            1, min(1440, int(body.get("retryDelayMinutes") or 5)))
    if any(key in body for key in (
            "assigneeId", "pluginBindingId", "personalPluginKey",
            "personalPluginVersionPolicy", "personalPluginVersion", "personalPluginChecksum",
            "requiredCapabilities")) and (not once_edit or before_execution != schedule_timing.execution_snapshot(s)):
        s.retry_count, s.next_retry_at = 0, None
    if "enabled" in body:
        s.enabled = bool(body.get("enabled"))
    try:
        schedule_timing.apply(s, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
