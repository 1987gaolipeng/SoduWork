"""Normalize GitHub Issues; Hub team membership controls their visibility."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import urllib.parse

from .github import GitHubHTTPError, _Client, _positive_id


def _utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("GitHub scan boundaries must be timezone-aware datetimes")
    return value.astimezone(timezone.utc)


def _actor(value) -> dict:
    if value is None:
        return {}  # Deleted GitHub authors can be null.
    if not isinstance(value, dict) or not isinstance(value.get("login"), str) or not value["login"].strip():
        raise ValueError("GitHub returned an invalid user identity")
    return {"id": _positive_id(value.get("id"), "user"), "username": value["login"],
        "name": str(value.get("name") or value["login"])}


def _issue(client, prefix: str, value, iid=None) -> dict:
    if not isinstance(value, dict) or "pull_request" in value:
        raise ValueError("GitHub returned a pull request instead of an Issue")
    number = _positive_id(value.get("number"), "Issue number")
    if iid is not None and number != iid:
        raise ValueError("GitHub returned a different Issue")
    if str(value.get("repository_url") or "").rstrip("/").lower() != (client.base + prefix).lower():
        raise ValueError("GitHub Issue belongs to a different repository")
    if value.get("state") not in ("open", "closed"):
        raise ValueError("GitHub returned an unknown Issue state")
    labels = value.get("labels")
    if not isinstance(labels, list) or any(not isinstance(label, (dict, str)) or
            not isinstance(label if isinstance(label, str) else label.get("name"), str) for label in labels):
        raise ValueError("GitHub returned an invalid Issue label list")
    assignees = value.get("assignees") or []
    if not isinstance(assignees, list):
        raise ValueError("GitHub returned an invalid Issue assignee list")
    return {"id": _positive_id(value.get("id"), "Issue id"), "iid": number,
        "state": "opened" if value["state"] == "open" else "closed",
        "title": str(value.get("title") or "未命名"), "description": str(value.get("body") or ""),
        "web_url": str(value.get("html_url") or ""), "created_at": value.get("created_at"),
        "labels": [label if isinstance(label, str) else label["name"] for label in labels],
        "author": _actor(value.get("user")), "assignees": [_actor(row) for row in assignees],
        "confidential": False}


def scan(config: dict, external_id, since: datetime, until: datetime) -> dict:
    start, end = _utc(since), _utc(until)
    if start > end:
        raise ValueError("GitHub Issue scan has an inverted time window")
    client = _Client(config or {})
    _, prefix = client.repository(external_id)
    # GitHub 'since' means updated-after, not created-after. Overlap by a second
    # for its strict timestamp boundary; filter the requested creation window here.
    lower = (start - timedelta(seconds=1)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    rows = client.pages(prefix + "/issues", {"state": "all", "since": lower,
        "sort": "created", "direction": "asc"})
    issues, seen = [], set()
    for row in rows:
        if "pull_request" in row:
            continue
        issue = _issue(client, prefix, row)
        if issue["iid"] in seen:
            raise ValueError("GitHub returned a duplicate Issue while paging")
        seen.add(issue["iid"])
        try:
            created = _utc(datetime.fromisoformat(str(issue["created_at"] or "").replace("Z", "+00:00")))
        except ValueError:
            raise ValueError("GitHub returned an invalid Issue creation time") from None
        if start <= created <= end:
            issues.append(issue)
    # GitHub requirements belong to the configured Hub team. Collaborator
    # enumeration is neither the visibility source nor a prerequisite for import.
    return {"issues": issues, "members": []}


def _ensure_label(client, prefix: str, label: str) -> None:
    """Create only a missing progress label, preserving existing label metadata."""
    endpoint = prefix + "/labels/" + urllib.parse.quote(label, safe="")
    try:
        value = client.json(endpoint)[0]
    except GitHubHTTPError as exc:
        if exc.code != 404:
            raise
        try:
            value = client.json(prefix + "/labels", method="POST",
                data={"name": label, "color": "0e8a16"})[0]
        except GitHubHTTPError as creation_error:
            if creation_error.code != 422:
                raise
            # Another started receipt may have created it after our GET.
            # A successful read is required; 422 alone is not an acknowledgement.
            value = client.json(endpoint)[0]
    if not isinstance(value, dict) or str(value.get("name") or "").casefold() != label.casefold():
        raise ValueError("GitHub did not confirm the progress label in the repository")


def started(config: dict, external_id, iid, label: str) -> dict:
    issue_iid = _positive_id(iid, "Issue number")
    if (not isinstance(label, str) or not label.strip() or label != label.strip()
            or len(label) > 50 or any(ord(char) < 32 for char in label)):
        raise ValueError("GitHub progress label must be one nonempty label of at most 50 characters")
    client = _Client(config or {})
    _, prefix = client.repository(external_id)
    endpoint = prefix + f"/issues/{issue_iid}"
    issue = _issue(client, prefix, client.json(endpoint)[0], issue_iid)
    if issue["state"] == "closed":
        return {"ok": False, "manual": True, "reason": "issue_closed", "issue": issue}
    if label.casefold() in {value.casefold() for value in issue["labels"]}:
        return {"ok": True, "already_started": True, "issue": issue}
    _ensure_label(client, prefix, label)
    client.json(endpoint + "/labels", method="POST", data={"labels": [label]})
    updated = _issue(client, prefix, client.json(endpoint)[0], issue_iid)
    if updated["state"] == "closed":
        return {"ok": False, "manual": True, "reason": "issue_closed", "issue": updated}
    if label.casefold() not in {value.casefold() for value in updated["labels"]}:
        raise ValueError("GitHub did not confirm the progress label after updating the Issue")
    return {"ok": True, "already_started": False, "issue": updated}
