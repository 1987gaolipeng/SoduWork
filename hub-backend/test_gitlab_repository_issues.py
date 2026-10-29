"""Local HTTP fixtures only; no Hub/database startup or real GitLab mutations."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest
from unittest.mock import patch
import urllib.parse

from app.config import Settings
from app.connectors import gitlab_repository_issues as adapter


def issue(iid=1, **changes):
    return {"id": 100 + iid, "iid": iid, "project_id": 149, "state": "opened",
        "title": "Fixture Issue", "description": "Fixture description", "labels": ["type::bug"],
        "created_at": "2026-10-23T01:00:00Z", "author": {"id": 1, "username": "author"},
        "assignees": [{"id": 2, "username": "assigned"}], **changes}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body, headers=None):
        payload = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Content-Type", "text/html" if isinstance(body, str) else "application/json")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(payload)

    def handle_request(self):
        fixture = self.server.fixture
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        body = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode())
        fixture.requests.append({"method": self.command, "path": url.path, "query": query, "body": body if self.command == "PUT" else {}})
        session = self.headers.get("Cookie") == "fixture_session=authenticated"
        token = self.headers.get("PRIVATE-TOKEN") == "fixture-token"
        if url.path == "/users/sign_in":
            self.send(200, '<input name="authenticity_token" value="login-csrf">')
            return
        if url.path == "/users/auth/ldapmain/callback":
            if body.get("username") != ["fixture-user"] or body.get("password") != ["fixture-password"]:
                self.send(401, {"error": "fixture login failed"})
            else:
                fixture.logins += 1
                self.send(200, "logged in", {"Set-Cookie": "fixture_session=authenticated; Path=/"})
            return
        if url.path == "/":
            self.send(200, '<meta content="session-csrf" name="csrf-token">' if session and not fixture.no_csrf else '<html></html>')
            return
        if not (session or token):
            self.send(401, {"error": "fixture unauthorized"})
            return
        if url.path == "/api/v4/user":
            self.send(200, {"id": 1, "username": "fixture-user"})
            return
        if fixture.api_error:
            self.send(fixture.api_error, {"error": "sensitive fixture response must never be surfaced"})
            return
        if fixture.redirect:
            self.send(302, {}, {"Location": fixture.redirect})
            return
        page = int(query.get("page", ["1"])[0])
        if url.path == "/api/v4/projects/149/issues":
            pages = fixture.issue_pages
            next_page = str(page + 1) if page < len(pages) or fixture.endless == "issues" else ""
            rows = pages[page - 1] if page <= len(pages) else ([] if fixture.no_page_headers else pages[-1])
            self.send(200, rows, {} if fixture.no_page_headers else {"X-Next-Page": next_page})
            return
        if url.path == "/api/v4/projects/149/members/all":
            pages = fixture.member_pages
            next_page = str(page + 1) if page < len(pages) or fixture.endless == "members" else ""
            rows = pages[page - 1] if page <= len(pages) else ([] if fixture.no_page_headers else pages[-1])
            self.send(200, rows, {} if fixture.no_page_headers else {"X-Next-Page": next_page})
            return
        if url.path == "/api/v4/projects/149/issues/1":
            if self.command == "PUT":
                if session and self.headers.get("X-CSRF-Token") != "session-csrf":
                    self.send(403, {"error": "missing CSRF"})
                    return
                if set(body) != {"add_labels"}:
                    self.send(400, {"error": "only additive labels permitted"})
                    return
                fixture.puts += 1
                label = body["add_labels"][0]
                if label not in fixture.current["labels"]:
                    fixture.current["labels"].append(label)
                if fixture.closed_race:
                    fixture.current["state"] = "closed"
                returned = deepcopy(fixture.current)
                if fixture.omit_label:
                    returned["labels"] = [value for value in returned["labels"] if value != label]
                self.send(200, returned)
            else:
                self.send(200, fixture.current)
            return
        self.send(404, {"error": "unknown fixture route"})

    do_GET = do_POST = do_PUT = handle_request


class GitLabRepositoryIssuesTests(unittest.TestCase):
    def setUp(self):
        # Settings() alone does not call resolve_secrets; connector lookups use
        # this explicit fixture settings object and cannot touch local secrets.
        self.settings = Settings(_env_file=None, database_url="sqlite+aiosqlite:///:memory:",
            auth_secret="fixture-auth-secret-not-used", admin_pass="fixture-admin-not-used",
            gitlab_base_url="", gitlab_token="", gitlab_project="", gitlab_verify_tls=True)
        self.settings_patch = patch("app.connectors.gitlab.get_settings", return_value=self.settings)
        self.settings_patch.start()
        self.addCleanup(self.settings_patch.stop)
        self.requests, self.puts, self.logins = [], 0, 0
        self.current = issue()
        self.issue_pages = [[issue(1)], [issue(2)]]
        self.member_pages = [[{"id": 1, "username": "direct", "access_level": 40}],
            [{"id": 2, "username": "inherited", "access_level": 30}]]
        self.endless, self.redirect = "", ""
        self.api_error = 0
        self.no_csrf = self.omit_label = self.closed_race = self.no_page_headers = False
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.fixture = self
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.config = {"base_url": "http://127.0.0.1:" + str(self.server.server_port), "token": "fixture-token"}
        self.since = datetime(2026, 10, 22, 3, tzinfo=timezone.utc)
        self.until = datetime(2026, 10, 23, 3, tzinfo=timezone.utc)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def ldap_config(self):
        return {"base_url": self.config["base_url"], "_auth_user": "fixture-user",
            "_auth_secret": "fixture-password", "_auth_kind": "password"}

    def test_full_issue_and_inherited_member_pagination_with_creation_bounds(self):
        result = adapter.scan(self.config, "149", self.since, self.until)
        self.assertEqual([value["iid"] for value in result["issues"]], [1, 2])
        self.assertEqual([value["username"] for value in result["members"]], ["direct", "inherited"])
        member_queries = [entry["query"] for entry in self.requests if entry["path"].endswith("/members/all")]
        self.assertEqual([query["state"] for query in member_queries], [["active"], ["active"]])
        issue_queries = [entry["query"] for entry in self.requests if entry["path"].endswith("/issues")]
        self.assertEqual(len(issue_queries), 2)
        for query in issue_queries:
            self.assertEqual(query["scope"], ["all"])
            self.assertEqual(query["state"], ["all"])
            self.assertEqual(query["order_by"], ["created_at"])
            self.assertEqual(query["sort"], ["asc"])
            self.assertEqual(query["created_after"], [self.since.isoformat()])
            self.assertEqual(query["created_before"], [self.until.isoformat()])
        self.assertEqual(self.puts, 0)

    def test_issue_and_member_page_limits_never_return_partial_success(self):
        for resource in ("issues", "members"):
            with self.subTest(resource=resource), patch.object(adapter, "_MAX_PAGES", 2):
                self.endless = resource
                with self.assertRaisesRegex(ValueError, "safe page limit"):
                    adapter.scan(self.config, 149, self.since, self.until)

    def test_missing_page_header_keeps_scanning_full_pages_for_both_resources(self):
        self.no_page_headers = True
        self.issue_pages = [[issue(iid) for iid in range(1, 101)], [issue(101)]]
        self.member_pages = [[{"id": i, "username": "member-" + str(i)} for i in range(1, 101)]]
        result = adapter.scan(self.config, 149, self.since, self.until)
        self.assertEqual(len(result["issues"]), 101)
        self.assertEqual(len(result["members"]), 100)
        for suffix in ("/issues", "/members/all"):
            pages = [entry["query"]["page"] for entry in self.requests if entry["path"].endswith(suffix)]
            self.assertEqual(pages, [["1"], ["2"]])

    def test_missing_page_header_at_limit_is_not_partial_success(self):
        self.no_page_headers = True
        self.issue_pages = [[issue(iid) for iid in range(1, 101)]]
        with patch.object(adapter, "_MAX_PAGES", 1), self.assertRaisesRegex(ValueError, "safe page limit"):
            adapter.scan(self.config, 149, self.since, self.until)

    def test_rejects_foreign_project_and_outside_window(self):
        missing_id = issue()
        del missing_id["id"]
        for changed in (issue(project_id=150), issue(created_at="2020-01-01T00:00:00Z"),
                        issue(id=0), missing_id):
            self.issue_pages = [[changed]]
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                adapter.scan(self.config, 149, self.since, self.until)

    def test_rejects_duplicate_issue_missing_member_identity_and_bad_time_bounds(self):
        self.issue_pages = [[issue()], [issue()]]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            adapter.scan(self.config, 149, self.since, self.until)
        self.issue_pages = [[issue()]]
        self.member_pages = [[{"id": 1}]]
        with self.assertRaisesRegex(ValueError, "username"):
            adapter.scan(self.config, 149, self.since, self.until)
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            adapter.scan(self.config, 149, self.since.replace(tzinfo=None), self.until)
        with self.assertRaisesRegex(ValueError, "inverted"):
            adapter.scan(self.config, 149, self.until, self.since)

    def test_pat_start_is_additive_and_a_repeat_does_not_write_again(self):
        first = adapter.started(self.config, 149, 1, "进行中")
        second = adapter.started(self.config, 149, 1, "进行中")
        self.assertTrue(first["ok"])
        self.assertFalse(first["already_started"])
        self.assertTrue(second["already_started"])
        self.assertEqual(self.puts, 1)
        self.assertEqual(self.current["labels"], ["type::bug", "进行中"])
        self.assertEqual([entry["body"] for entry in self.requests if entry["method"] == "PUT"], [{"add_labels": ["进行中"]}])

    def test_closed_issue_is_manual_without_writing_even_if_label_already_exists(self):
        self.current = issue(state="closed", labels=["进行中"])
        result = adapter.started(self.config, 149, 1, "进行中")
        self.assertEqual((result["ok"], result["manual"], result["reason"]), (False, True, "issue_closed"))
        self.assertEqual(self.puts, 0)

    def test_ldap_reuses_session_and_supplies_post_login_csrf(self):
        result = adapter.started(self.ldap_config(), 149, 1, "进行中")
        self.assertTrue(result["ok"])
        self.assertEqual(self.logins, 1)
        self.assertEqual(self.puts, 1)
        self.assertIn("type::bug", result["issue"]["labels"])

    def test_ldap_missing_csrf_prevents_write(self):
        self.no_csrf = True
        with self.assertRaisesRegex(ValueError, "CSRF"):
            adapter.started(self.ldap_config(), 149, 1, "进行中")
        self.assertEqual(self.puts, 0)

    def test_response_must_confirm_label_and_closed_race_stays_manual(self):
        self.omit_label = True
        with self.assertRaisesRegex(ValueError, "did not confirm"):
            adapter.started(self.config, 149, 1, "进行中")
        self.omit_label = False
        self.closed_race = True
        self.current = issue()
        result = adapter.started(self.config, 149, 1, "进行中")
        self.assertFalse(result["ok"])
        self.assertTrue(result["manual"])
        self.assertEqual(result["issue"]["state"], "closed")

    def test_invalid_labels_and_foreign_issue_fail_without_write(self):
        for label in ("", "a,b", " doing", "doing\n", "status::doing", "a" * 121):
            with self.subTest(label=label), self.assertRaises(ValueError):
                adapter.started(self.config, 149, 1, label)
        self.current = issue(project_id=200)
        with self.assertRaisesRegex(ValueError, "different project"):
            adapter.started(self.config, 149, 1, "进行中")
        self.current = issue(iid=2)
        with self.assertRaisesRegex(ValueError, "different Issue"):
            adapter.started(self.config, 149, 1, "进行中")
        self.assertEqual(self.puts, 0)

    def test_http_failure_does_not_include_server_body_or_secret(self):
        self.api_error = 403
        with self.assertRaisesRegex(ValueError, "HTTP 403") as raised:
            adapter.scan(self.config, 149, self.since, self.until)
        self.assertNotIn("sensitive", str(raised.exception))
        self.assertNotIn("fixture-token", str(raised.exception))

    def test_http_failure_retains_structured_status_without_response_data(self):
        for code in (401, 403, 404, 429, 503):
            self.api_error = code
            with self.subTest(code=code), self.assertRaises(adapter.GitLabHTTPError) as raised:
                adapter.scan(self.config, 149, self.since, self.until)
            self.assertEqual(raised.exception.code, code)
            self.assertEqual(vars(raised.exception), {"code": code})
            self.assertNotIn("sensitive", str(raised.exception))
            self.assertNotIn("fixture-token", str(raised.exception))

    def test_authenticated_redirect_cannot_escape_source_origin(self):
        self.redirect = "http://127.0.0.1:1/unrelated"
        with self.assertRaisesRegex(ValueError, "outside the configured origin"):
            adapter.scan(self.config, 149, self.since, self.until)


if __name__ == "__main__":
    unittest.main()
