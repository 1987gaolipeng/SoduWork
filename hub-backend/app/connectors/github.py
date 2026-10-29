"""GitHub repository catalog and isolated, integration-scoped REST transport.

Issue import is opt-in through repository_issue_sync, never the legacy poller.
"""
from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

_PER_PAGE = 100
_MAX_PAGES = 200


class GitHubHTTPError(ValueError):
    """Retain only status, never an upstream URL, token, headers or response body."""

    def __init__(self, code: int, method: str):
        self.code = int(code)
        super().__init__(f"GitHub {method} failed (HTTP {self.code})")


def _positive_id(value, field: str) -> int:
    text = str(value or "")
    if not text.isascii() or not text.isdigit() or int(text) <= 0:
        raise ValueError(f"GitHub {field} must be a positive numeric ID")
    return int(text)


def _origin(url: str) -> tuple:
    parts = urllib.parse.urlsplit(url)
    return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)


def _api_base(config: dict) -> str:
    explicit = str(config.get("api_url") or "").strip()
    base = (explicit or str(config.get("base_url") or "https://github.com")).strip().rstrip("/")
    parts = urllib.parse.urlsplit(base)
    if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username
            or parts.password or parts.query or parts.fragment):
        raise ValueError("GitHub repository source needs a valid HTTP(S) base URL")
    _origin(base)  # Validate the port before any credential is attached.
    if parts.hostname.lower() in {"github.com", "www.github.com"}:
        if parts.path:
            raise ValueError("GitHub base URL must not include a repository path")
        return "https://api.github.com"
    if parts.hostname.lower() == "api.github.com":
        if parts.path or parts.scheme != "https":
            raise ValueError("GitHub API base URL must use HTTPS without a path")
        return "https://api.github.com"
    return base if explicit or parts.path.endswith("/api/v3") else base + "/api/v3"


def _token(config: dict) -> str:
    # Materialized fields include a deliberate draft override from account verification.
    if any(key in config for key in ("_auth_user", "_auth_secret", "_auth_kind")):
        secret, kind = config.get("_auth_secret"), config.get("_auth_kind")
    elif isinstance(config.get("pullAuth"), dict) and config["pullAuth"]:
        secret, kind = config["pullAuth"].get("secret"), config["pullAuth"].get("kind")
    else:
        secret, kind = config.get("token"), "token"
    if str(kind or "").strip().lower() not in ("", "token"):
        raise ValueError("GitHub 只支持访问令牌，请将拉取账号的认证方式设为访问令牌")
    token = str(secret or "").strip()
    if not token or not token.isascii() or any(char.isspace() or ord(char) < 32 for char in token):
        raise ValueError("GitHub 拉取令牌未配置或格式无效，请在当前集成中填写访问令牌")
    return token


class _SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    handler_order = 499

    def __init__(self, base: str):
        self.origin = _origin(base)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if _origin(newurl) != self.origin:
            fp.close()
            raise ValueError("GitHub refused a redirect outside the configured origin")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _repository_name(value) -> str:
    name = str(value or "")
    parts = name.split("/")
    if len(parts) != 2 or any(part in {"", ".", ".."} or not re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts):
        raise ValueError("GitHub returned an invalid repository identity")
    return name


class _Client:
    def __init__(self, config: dict):
        self.base = _api_base(config)
        token = _token(config)
        handlers = [_SameOriginRedirect(self.base)]
        if not config.get("use_proxy"):
            handlers.append(urllib.request.ProxyHandler({}))
        if config.get("verify_tls", True) is False:
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=context))
        self.opener = urllib.request.build_opener(*handlers)
        self.auth = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SoduWork-repository-sync"}

    def json(self, endpoint: str, *, method="GET", data=None):
        if not endpoint.startswith("/") or endpoint.startswith("//"):
            raise ValueError("GitHub request must stay within the configured API")
        payload = json.dumps(data).encode("utf-8") if data is not None else None
        headers = {**self.auth, **({"Content-Type": "application/json"} if payload is not None else {})}
        request = urllib.request.Request(self.base + endpoint, method=method, data=payload, headers=headers)
        try:
            with self.opener.open(request, timeout=25) as response:
                body, result_headers = response.read(), response.headers
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            raise GitHubHTTPError(status, method) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ValueError(f"GitHub {method} could not reach the configured server") from None
        try:
            return json.loads(body), result_headers
        except (ValueError, UnicodeDecodeError):
            raise ValueError("GitHub returned an invalid JSON response") from None

    def pages(self, endpoint: str, params=None) -> list[dict]:
        rows = []
        for page in range(1, _MAX_PAGES + 1):
            expected = {**(params or {}), "per_page": _PER_PAGE, "page": page}
            query = urllib.parse.urlencode(expected)
            batch, headers = self.json(endpoint + "?" + query)
            if not isinstance(batch, list) or any(not isinstance(row, dict) for row in batch):
                raise ValueError("GitHub returned an invalid paginated response")
            rows.extend(batch)
            link = headers.get("Link")
            next_links = re.findall(r'<([^>]+)>\s*;\s*rel="next"', link or "")
            if len(next_links) > 1:
                raise ValueError("GitHub returned an invalid next-page cursor")
            if next_links:
                target = urllib.parse.urlsplit(next_links[0])
                expected["page"] = page + 1
                if (_origin(next_links[0]) != _origin(self.base) or target.username or target.password
                        or target.fragment or target.path != urllib.parse.urlsplit(self.base + endpoint).path
                        or urllib.parse.parse_qs(target.query) != urllib.parse.parse_qs(urllib.parse.urlencode(expected))):
                    raise ValueError("GitHub returned an invalid next-page cursor")
                continue
            if link is None and len(batch) >= _PER_PAGE:
                continue  # A proxy may strip Link; probe rather than truncate the snapshot.
            return rows
        raise ValueError("GitHub repository scan exceeded its safe page limit")

    def repository(self, external_id) -> tuple[dict, str]:
        expected = _positive_id(external_id, "repository")
        row = self.json(f"/repositories/{expected}")[0]
        if not isinstance(row, dict) or _positive_id(row.get("id"), "repository") != expected:
            raise ValueError("GitHub returned a different repository")
        return row, "/repos/" + _repository_name(row.get("full_name"))


class GitHubConnector:
    type = "github"
    scheduled = False

    def verify(self, config: dict) -> dict:
        try:
            client = _Client(config or {})
            who = client.json("/user")[0]
            if not isinstance(who, dict) or not isinstance(who.get("login"), str) or not who["login"]:
                raise ValueError("GitHub returned an invalid authenticated user")
            _positive_id(who.get("id"), "user")
            client.pages("/user/repos", {"visibility": "all", "affiliation": "owner,collaborator,organization_member"})
            return {"ok": True, "detail": f"GitHub 认证成功，登录为 {who['login']}，仓库目录可读取"}
        except ValueError as exc:
            return {"ok": False, "detail": str(exc)}

    def list_repositories(self, config: dict) -> list[dict]:
        client, seen, out = _Client(config or {}), set(), []
        rows = client.pages("/user/repos", {"visibility": "all", "affiliation": "owner,collaborator,organization_member",
            "sort": "full_name", "direction": "asc"})
        for row in rows:
            rid = _positive_id(row.get("id"), "repository")
            if rid in seen:
                raise ValueError("GitHub returned a duplicate repository while paging")
            seen.add(rid)
            full_name = _repository_name(row.get("full_name"))
            out.append({"externalId": str(rid), "fullName": full_name,
                "displayName": str(row.get("name") or full_name.split("/")[-1]),
                "cloneUrl": str(row.get("clone_url") or ""), "sshUrl": str(row.get("ssh_url") or ""),
                "webUrl": str(row.get("html_url") or ""), "defaultBranch": str(row.get("default_branch") or "main"),
                "visibility": str(row.get("visibility") or ("private" if row.get("private") else "public")),
                "archived": bool(row.get("archived")),
                "metadata": {"owner": row.get("owner") or {}, "hasIssues": row.get("has_issues", True)}})
        return out

    def list_branches(self, config: dict, external_id: str) -> list[str]:
        client = _Client(config or {})
        _, prefix = client.repository(external_id)
        rows = client.pages(prefix + "/branches")
        if any(not isinstance(row.get("name"), str) or not row["name"] for row in rows):
            raise ValueError("GitHub returned an invalid branch")
        return [row["name"] for row in rows]

    def pull(self, config: dict, cursor: dict) -> tuple[list[dict], dict]:
        return [], dict(cursor or {})

    def parse_webhook(self, headers: dict, body: bytes) -> list[dict]:
        return []  # Repository subscriptions are the only GitHub Issue import path.
