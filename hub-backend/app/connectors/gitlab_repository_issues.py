"""Repository-scoped Issue scanning and additive first-start acknowledgement.

Authentication and proxy/TLS policy follow the existing GitLab connector. This
adapter does not create Issues, close/reopen them, or replace their label lists.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from html.parser import HTMLParser
import urllib.error
import urllib.parse
import urllib.request

from .gitlab import GitLabConnector

_PER_PAGE = 100
_MAX_PAGES = 200


class GitLabHTTPError(ValueError):
    """Carry the upstream status without retaining its URL, body or headers."""

    def __init__(self, code: int, method: str):
        self.code = int(code)
        super().__init__(f"GitLab {method} failed (HTTP {self.code})")


def _positive_id(value, field: str) -> int:
    text = str(value or "")
    if not text.isascii() or not text.isdigit() or int(text) <= 0:
        raise ValueError(f"GitLab {field} must be a positive numeric ID")
    return int(text)


def _utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("GitLab scan boundaries must be timezone-aware datetimes")
    return value.astimezone(timezone.utc)


def _origin(url: str) -> tuple:
    parts = urllib.parse.urlsplit(url)
    return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)


class _SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    handler_order = 499

    def __init__(self, base: str):
        self.origin = _origin(base)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if _origin(newurl) != self.origin:
            fp.close()
            raise ValueError("GitLab refused a redirect outside the configured origin")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _CsrfParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.token = ""

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta" and values.get("name") == "csrf-token":
            self.token = str(values.get("content") or "")


class _Client:
    def __init__(self, config: dict, external_id):
        self.project_id = _positive_id(external_id, "project")
        connector = GitLabConnector()
        self.base, _, _ = connector._cfg(config)
        parts = urllib.parse.urlsplit(self.base)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("GitLab repository source needs a valid HTTP(S) base URL")
        self.opener = connector._opener(config)
        self.opener.add_handler(_SameOriginRedirect(self.base))
        self.auth = connector._api_headers(config, self.opener)
        self.prefix = f"/api/v4/projects/{self.project_id}"

    def request(self, endpoint: str, *, method="GET", data=None, headers=None):
        request = urllib.request.Request(self.base + endpoint, method=method, data=data,
            headers={**self.auth, "Accept": "application/json", **(headers or {})})
        try:
            with self.opener.open(request, timeout=25) as response:
                return response.read(), response.headers
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            raise GitLabHTTPError(status, method) from None
        except urllib.error.URLError:
            raise ValueError(f"GitLab {method} could not reach the configured server") from None

    def json(self, endpoint: str, **kwargs):
        body, headers = self.request(endpoint, **kwargs)
        try:
            return json.loads(body), headers
        except (ValueError, UnicodeDecodeError):
            raise ValueError("GitLab returned an invalid JSON response") from None

    def pages(self, suffix: str, params=None) -> list[dict]:
        rows = []
        for page in range(1, _MAX_PAGES + 1):
            query = urllib.parse.urlencode({**(params or {}), "per_page": _PER_PAGE, "page": page})
            batch, headers = self.json(self.prefix + suffix + "?" + query)
            if not isinstance(batch, list) or any(not isinstance(row, dict) for row in batch):
                raise ValueError("GitLab returned an invalid paginated response")
            rows.extend(batch)
            cursor = headers.get("X-Next-Page")
            if cursor is None and len(batch) >= _PER_PAGE:
                # Some proxies strip pagination headers. Probe the following
                # page instead of silently accepting a truncated snapshot.
                continue
            next_page = (cursor or "").strip()
            if not next_page:
                return rows
            if not next_page.isascii() or not next_page.isdigit() or int(next_page) != page + 1:
                raise ValueError("GitLab returned an invalid next-page cursor")
        raise ValueError("GitLab repository Issue scan exceeded its safe page limit")

    def issue(self, value, iid=None) -> dict:
        if not isinstance(value, dict) or _positive_id(value.get("project_id"), "Issue project") != self.project_id:
            raise ValueError("GitLab Issue belongs to a different project")
        actual_iid = _positive_id(value.get("iid"), "Issue iid")
        _positive_id(value.get("id"), "Issue id")
        if iid is not None and actual_iid != iid:
            raise ValueError("GitLab returned a different Issue")
        if value.get("state") not in ("opened", "closed"):
            raise ValueError("GitLab returned an unknown Issue state")
        if not isinstance(value.get("labels"), list) or any(not isinstance(label, str) for label in value["labels"]):
            raise ValueError("GitLab returned an invalid Issue label list")
        return value

    def csrf(self) -> dict:
        if self.auth:
            return {}  # Access-token requests do not use browser-session CSRF.
        body, _ = self.request("/", headers={"Accept": "text/html"})
        parser = _CsrfParser()
        parser.feed(body.decode("utf-8", "replace"))
        if not parser.token:
            raise ValueError("GitLab session did not provide a CSRF token; no Issue was changed")
        return {"X-CSRF-Token": parser.token}


def scan(config: dict, external_id, since: datetime, until: datetime) -> dict:
    """Read all Issues created in the bounded window and all inherited members."""
    start, end = _utc(since), _utc(until)
    if start > end:
        raise ValueError("GitLab Issue scan has an inverted time window")
    client = _Client(config or {}, external_id)
    issues = client.pages("/issues", {"scope": "all", "state": "all",
        "created_after": start.isoformat(), "created_before": end.isoformat(),
        "order_by": "created_at", "sort": "asc"})
    seen = set()
    for value in issues:
        issue = client.issue(value)
        if issue["iid"] in seen:
            raise ValueError("GitLab returned a duplicate Issue while paging")
        seen.add(issue["iid"])
        try:
            created = _utc(datetime.fromisoformat(str(issue.get("created_at") or "").replace("Z", "+00:00")))
        except ValueError:
            raise ValueError("GitLab returned an invalid Issue creation time") from None
        if not start <= created <= end:
            raise ValueError("GitLab returned an Issue outside the requested creation window")
    members = client.pages("/members/all", {"state": "active"})
    for member in members:
        _positive_id(member.get("id"), "member")
        if not isinstance(member.get("username"), str) or not member["username"].strip():
            raise ValueError("GitLab returned a member without a username")
    return {"issues": issues, "members": members}


def started(config: dict, external_id, iid, label: str) -> dict:
    """Add one progress label, preserve every existing label, and verify receipt."""
    issue_iid = _positive_id(iid, "Issue iid")
    if not isinstance(label, str) or not label.strip() or len(label) > 120 or label != label.strip() or "," in label or "::" in label or any(ord(char) < 32 for char in label):
        raise ValueError("GitLab progress label must be one nonempty label")
    client = _Client(config or {}, external_id)
    endpoint = client.prefix + f"/issues/{issue_iid}"
    issue = client.issue(client.json(endpoint)[0], issue_iid)
    if issue["state"] == "closed":
        return {"ok": False, "manual": True, "reason": "issue_closed", "issue": issue}
    if label in issue["labels"]:
        return {"ok": True, "already_started": True, "issue": issue}
    body = urllib.parse.urlencode({"add_labels": label}).encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded", **client.csrf()}
    updated = client.issue(client.json(endpoint, method="PUT", data=body, headers=headers)[0], issue_iid)
    if updated["state"] == "closed":
        return {"ok": False, "manual": True, "reason": "issue_closed", "issue": updated}
    if label not in updated["labels"]:
        raise ValueError("GitLab did not confirm the progress label after updating the Issue")
    return {"ok": True, "already_started": False, "issue": updated}
