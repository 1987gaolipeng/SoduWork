"""Convert GitLab issues received through REST polling or issue webhooks into Envelopes for the
shared ingest pipeline, using only stdlib urllib. Non-secret base_url and project configuration
may override settings. Obtain PRIVATE-TOKEN credentials from GITLAB_TOKEN rather than persisted
integration configuration. use_proxy defaults to false for direct access; enable it for
endpoints requiring a proxy. verify_tls defaults to the configured verification policy. The
updated_after cursor supports idempotent incremental upserts, including repeated boundary
records."""
import http.cookiejar
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

from ..config import get_settings

_PER_PAGE = 50
_MAX_PAGES = 40  # Bound each pull to approximately 2,000 issues; continue on a later poll.
_REPO_MAX_PAGES = 200  # Limit catalogs to 20,000 repositories and fail the whole refresh rather than replace with partial data.
_BRANCH_MAX_PAGES = 50  # Reject repositories exceeding 5,000 branches instead of silently truncating their catalog.

# Map case-insensitive GitLab labels to task status, urgency, and importance.
_DOING = ("doing", "in progress", "in-progress", "wip", "进行中", "处理中")
_URGENT = ("urgent", "critical", "紧急", "p0", "p1", "blocker")
_IMPORTANT = ("important", "重要", "major", "high")


def _labels_lower(raw) -> list[str]:
    """Normalize REST string labels and webhook label objects to lowercase strings."""
    out: list[str] = []
    for x in raw or []:
        if isinstance(x, dict):
            x = x.get("title") or x.get("name") or ""
        out.append(str(x).lower())
    return out


def _status_from(state: str | None, labels_l: list[str]) -> str:
    if state == "closed":
        return "done"
    if any(k in labels_l for k in _DOING):
        return "doing"
    return "todo"  # Map opened, reopened, and unknown states to todo.


def _flag(labels_l: list[str], keys) -> bool | None:
    return True if any(k in labels_l for k in keys) else None  # Return True on a matching label, otherwise None for unknown.


def _assignee_username(*sources) -> str | None:
    """Read the first username from assignees or the singular assignee object."""
    for s in sources:
        if isinstance(s, list) and s and isinstance(s[0], dict):
            if s[0].get("username"):
                return s[0]["username"]
        elif isinstance(s, dict) and s.get("username"):
            return s["username"]
    return None


class GitLabConnector:
    type = "gitlab"
    scheduled = True  # Enable scheduled polling; adapters without this flag remain manual-only.

    # Configuration resolution.
    def _cfg(self, config: dict) -> tuple[str, str, str]:
        s = get_settings()
        base = (config.get("base_url") or s.gitlab_base_url or "").rstrip("/")
        project = str(config.get("project") or s.gitlab_project or "")
        token = config.get("token") or s.gitlab_token or ""
        return base, project, token

    def _opener(self, config: dict) -> urllib.request.OpenerDirector:
        # Always install a cookie handler: PAT authentication ignores it, while password login needs the LDAP session.
        handlers: list = [urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())]
        if not config.get("use_proxy"):
            handlers.append(urllib.request.ProxyHandler({}))  # Bypass proxies for direct internal GitLab access.
        verify = config.get("verify_tls", get_settings().gitlab_verify_tls)
        if not verify:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        return urllib.request.build_opener(*handlers)

    def _api_headers(self, config: dict, opener: urllib.request.OpenerDirector) -> dict:
        """Use the selected pull account; legacy tokens are a fallback only.

        Automatic mode tries a PAT first and falls back to password login only
        for HTTP 401. Network, permission and rate-limit failures do not change
        the credential's meaning or trigger another login attempt.
        """
        base = (config.get("base_url") or get_settings().gitlab_base_url or "").rstrip("/")
        user = str(config.get("_auth_user") or "")
        secret = str(config.get("_auth_secret") or "")
        if not (user and secret):
            token = config.get("token") or get_settings().gitlab_token or ""
            if token and not (user or secret):
                return {"PRIVATE-TOKEN": token}
            raise ValueError("GitLab 拉取账号未配置（先在「仓库目录」里填用户名和密码/令牌）")
        kind = str(config.get("_auth_kind") or "")
        if kind not in ("", "password", "token"):
            raise ValueError("GitLab 认证方式无效，请选择自动识别、登录密码或访问令牌")
        if kind == "token":
            return {"PRIVATE-TOKEN": secret}
        if kind != "password":
            try:
                req = urllib.request.Request(
                    base + "/api/v4/user",
                    headers={"PRIVATE-TOKEN": secret, "Accept": "application/json"})
                with opener.open(req, timeout=15) as response:
                    who = json.loads(response.read())
                if not isinstance(who, dict) or not who.get("id") or not who.get("username"):
                    raise ValueError("invalid user response")
                return {"PRIVATE-TOKEN": secret}
            except urllib.error.HTTPError as exc:
                code = exc.code
                exc.close()
                if code != 401:
                    raise ValueError(f"GitLab 认证请求失败（HTTP {code}），请检查权限或稍后重试") from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise ValueError("GitLab 认证请求无法连接或超时，请检查地址和网络") from None
            except (ValueError, UnicodeDecodeError):
                raise ValueError("GitLab 认证接口未返回有效用户，请检查地址或登录代理") from None
        self._ldap_login(base, opener, user, secret)
        return {}

    def _ldap_login(self, base: str, opener: urllib.request.OpenerDirector,
                    user: str, password: str) -> None:
        """Authenticate through LDAP by obtaining the login CSRF token, posting to the LDAP
        callback or standard form, and verifying the resulting session with /api/v4/user."""
        try:
            with opener.open(base + "/users/sign_in", timeout=20) as resp:
                html = resp.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"连不上 GitLab 登录页（{type(exc).__name__}）") from exc
        m = re.search(r'name="authenticity_token" value="([^"]+)"', html)
        if not m:
            raise ValueError("GitLab 登录页没拿到 CSRF（地址或版本不对？）")
        csrf = m.group(1)
        attempts = [
            ("/users/auth/ldapmain/callback",
             {"authenticity_token": csrf, "username": user,
              "password": password, "remember_me": "0"}),
            ("/users/sign_in",
             {"authenticity_token": csrf, "user[login]": user,
              "user[password]": password, "user[remember_me]": "0"}),
        ]
        for path, fields in attempts:
            try:
                opener.open(urllib.request.Request(
                    base + path, data=urllib.parse.urlencode(fields).encode()),
                    timeout=25).read()
            except Exception:  # noqa: BLE001
                continue
            try:
                req = urllib.request.Request(
                    base + "/api/v4/user", headers={"Accept": "application/json"})
                with opener.open(req, timeout=15) as resp:
                    if resp.status == 200:
                        return
            except Exception:  # noqa: BLE001
                continue
        raise ValueError("GitLab 账号或密码不对（LDAP 登录没通过）")

    def verify(self, config: dict) -> dict:
        """Probe source credentials and count visible repositories after successful authentication.

        """
        base = (config.get("base_url") or get_settings().gitlab_base_url or "").rstrip("/")
        if not base:
            return {"ok": False, "detail": "还没填 GitLab 地址"}
        opener = self._opener(config or {})
        try:
            headers = self._api_headers(config or {}, opener)
        except ValueError as exc:
            return {"ok": False, "detail": str(exc)}
        try:
            req = urllib.request.Request(
                base + "/api/v4/user", headers={**headers, "Accept": "application/json"})
            with opener.open(req, timeout=20) as resp:
                who = json.loads(resp.read().decode("utf-8"))
            req2 = urllib.request.Request(
                base + "/api/v4/projects?per_page=1&simple=true&membership=true",
                headers={**headers, "Accept": "application/json"})
            with opener.open(req2, timeout=20) as resp:
                total = resp.headers.get("X-Total") or "?"
            return {"ok": True,
                    "detail": f"通了 —— 登录为 {who.get('username') or who.get('name')}，"
                              f"能看到 {total} 个仓库"}
        except urllib.error.HTTPError as exc:
            code = exc.code
            hint = {401: "账号或密码不对", 403: "这个账号没有权限"}.get(code, f"HTTP {code}")
            return {"ok": False, "detail": f"没通过：{hint}"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "detail": f"连不上（{type(exc).__name__}）——内网地址？要挂代理吗"}

    def list_repositories(self, config: dict) -> list[dict]:
        """Return every project visible to the configured GitLab account."""
        base, _, _ = self._cfg(config or {})
        if not base:
            raise ValueError("GitLab address is missing")
        opener = self._opener(config or {})
        auth = self._api_headers(config or {}, opener)
        page, out = 1, []
        while page and page <= _REPO_MAX_PAGES:
            params = {
                "simple": "true", "archived": "false",
                "per_page": "100", "page": str(page),
                "order_by": "path", "sort": "asc",
            }
            if config.get("membership_only"):
                params["membership"] = "true"
            req = urllib.request.Request(
                f"{base}/api/v4/projects?{urllib.parse.urlencode(params)}",
                headers={**auth, "Accept": "application/json"})
            with opener.open(req, timeout=25) as resp:
                rows = json.loads(resp.read().decode("utf-8"))
                next_page = (resp.headers.get("X-Next-Page") or "").strip()
            for row in rows if isinstance(rows, list) else []:
                out.append({
                    "externalId": str(row.get("id") or ""),
                    "fullName": str(row.get("path_with_namespace") or row.get("name") or ""),
                    "displayName": str(row.get("name") or ""),
                    "cloneUrl": str(row.get("http_url_to_repo") or ""),
                    "sshUrl": str(row.get("ssh_url_to_repo") or ""),
                    "webUrl": str(row.get("web_url") or ""),
                    "defaultBranch": str(row.get("default_branch") or "main"),
                    "visibility": str(row.get("visibility") or ""),
                    "archived": bool(row.get("archived")),
                    "metadata": {"namespace": row.get("namespace") or {}},
                })
            page = int(next_page) if next_page.isdigit() else 0
        if page:
            raise ValueError("GitLab repository catalog exceeds the safe page limit")
        return out

    def list_branches(self, config: dict, external_id: str) -> list[str]:
        base, _, _ = self._cfg(config or {})
        if not (base and external_id):
            raise ValueError("GitLab repository branch query is not configured")
        opener = self._opener(config or {})
        auth = self._api_headers(config or {}, opener)
        project = urllib.parse.quote(str(external_id), safe="")
        page, out = 1, []
        while page and page <= _BRANCH_MAX_PAGES:
            params = {"per_page": "100", "page": str(page)}
            req = urllib.request.Request(
                f"{base}/api/v4/projects/{project}/repository/branches?"
                f"{urllib.parse.urlencode(params)}",
                headers={**auth, "Accept": "application/json"})
            with opener.open(req, timeout=25) as resp:
                rows = json.loads(resp.read().decode("utf-8"))
                next_page = (resp.headers.get("X-Next-Page") or "").strip()
            out.extend(str(row.get("name") or "") for row in rows
                       if isinstance(row, dict) and row.get("name"))
            page = int(next_page) if next_page.isdigit() else 0
        if page:
            raise ValueError("GitLab branch catalog exceeds the safe page limit")
        return out
    # ---------- issue → Envelope ----------
    def _issue_to_env(self, issue: dict, project_label: str = "") -> tuple[dict, str | None]:
        iid = issue.get("iid") or issue.get("id")
        labels_l = _labels_lower(issue.get("labels"))
        env = {
            "external_id": str(iid),
            "external_project_id": str(issue.get("project_id") or ""),
            "external_url": issue.get("web_url"),
            "title": issue.get("title") or "未命名",
            "note": (issue.get("description") or "")[:2000],
            "status": _status_from(issue.get("state"), labels_l),
            "assignee": _assignee_username(issue.get("assignees"), issue.get("assignee")),
            "urgent": _flag(labels_l, _URGENT),
            "important": _flag(labels_l, _IMPORTANT),
            "source_label": (issue.get("references") or {}).get("full")
            or (f"{project_label}#{iid}" if project_label else f"#{iid}"),
        }
        return env, issue.get("updated_at")

    # Scheduled incremental pulls.
    def pull(self, config: dict, cursor: dict) -> tuple[list[dict], dict]:
        base, project, token = self._cfg(config or {})
        cur = dict(cursor or {})
        if not (base and project and token):
            return [], cur  # Skip pulls when required connection configuration is incomplete.
        proj = urllib.parse.quote(project, safe="")
        opener = self._opener(config or {})
        base_params = {"order_by": "updated_at", "sort": "asc", "per_page": str(_PER_PAGE)}
        if cur.get("updated_after"):
            base_params["updated_after"] = cur["updated_after"]

        envelopes: list[dict] = []
        max_updated = cur.get("updated_after")
        page, pages = 1, 0
        while page and pages < _MAX_PAGES:
            params = dict(base_params, page=str(page))
            url = f"{base}/api/v4/projects/{proj}/issues?{urllib.parse.urlencode(params)}"
            req = urllib.request.Request(
                url, headers={"PRIVATE-TOKEN": token, "Accept": "application/json"}
            )
            with opener.open(req, timeout=25) as resp:
                issues = json.loads(resp.read().decode("utf-8"))
                next_page = (resp.headers.get("X-Next-Page") or "").strip()
            for issue in issues:
                env, updated = self._issue_to_env(issue)
                envelopes.append(env)
                if updated and (max_updated is None or updated > max_updated):
                    max_updated = updated
            page = int(next_page) if next_page.isdigit() else 0
            pages += 1

        if max_updated:
            cur["updated_after"] = max_updated
        return envelopes, cur

    # ---------- webhook（Issue Hook）----------
    def parse_webhook(self, headers: dict, body: bytes) -> list[dict]:
        try:
            data = json.loads(body or b"{}")
        except Exception:
            return []
        if not isinstance(data, dict) or data.get("object_kind") != "issue":
            return []  # Process issue events only; ignore push, merge-request, and note events.
        oa = data.get("object_attributes") or {}
        iid = oa.get("iid") or oa.get("id")
        if not iid:
            return []
        labels_l = _labels_lower(data.get("labels") or oa.get("labels"))
        project = data.get("project") or {}
        project_label = project.get("path_with_namespace") or ""
        env = {
            "external_id": str(iid),
            "external_project_id": str(project.get("id") or oa.get("project_id") or ""),
            "external_url": oa.get("url"),
            "title": oa.get("title") or "未命名",
            "note": (oa.get("description") or "")[:2000],
            "status": _status_from(oa.get("state"), labels_l),
            "assignee": _assignee_username(data.get("assignees")),
            "urgent": _flag(labels_l, _URGENT),
            "important": _flag(labels_l, _IMPORTANT),
            "source_label": f"{project_label}#{iid}" if project_label else f"#{iid}",
        }
        return [env]
