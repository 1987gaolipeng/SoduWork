"""Local HTTP fixtures for GitHub catalog and Issues; no real service writes."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading
import unittest
from unittest.mock import patch
import urllib.parse

from app.connectors import github
from app.connectors import github_repository_issues as adapter


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, payload, headers=None):
        body = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def handle_request(self):
        f = self.server.fixture
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        body = json.loads(data) if data else None
        f.requests.append({"path": parsed.path, "method": self.command, "query": query,
            "body": body, "auth": self.headers.get("Authorization"),
            "version": self.headers.get("X-GitHub-Api-Version"), "agent": self.headers.get("User-Agent")})
        if self.headers.get("Authorization") != "Bearer " + f.expected_token:
            self.send(401, {"message": "fixture sensitive token must not be surfaced"})
            return
        if f.redirect:
            self.send(302, {}, {"Location": f.redirect})
            return
        if f.api_error or parsed.path in f.errors:
            self.send(f.errors.get(parsed.path, f.api_error), {"message": "sensitive fixture response"})
            return
        if f.invalid_json:
            self.send(200, "fixture-invalid-json-with-private-details")
            return
        if parsed.path == "/user":
            self.send(200, {"id": 2, "login": "fixture-user"})
            return
        if parsed.path == "/repositories/149":
            self.send(200, f.repository)
            return
        if parsed.path.startswith("/repos/acme/widget/labels/"):
            name = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
            if name in f.repository_labels:
                self.send(200, {"name": name, "color": "ffffff"})
            else:
                self.send(404, {"message": "fixture label missing"})
            return
        if parsed.path == "/repos/acme/widget/labels" and self.command == "POST":
            f.label_creates += 1
            if not f.label_not_created:
                f.repository_labels.add(body["name"])
            self.send(422 if f.label_creation_race else 201, body)
            return
        if parsed.path in f.pages:
            page = int(query.get("page", ["1"])[0])
            pages = f.pages[parsed.path]
            rows = pages[page - 1] if page <= len(pages) else []
            headers = {}
            if not f.no_page_headers:
                headers["Link"] = ""
                if page < len(pages) or f.endless:
                    next_query = {key: values[0] for key, values in query.items()}
                    next_query["page"] = page + 1
                    target = f.base + parsed.path + "?" + urllib.parse.urlencode(next_query)
                    headers["Link"] = '<' + (f.next_link or target) + '>; rel="next"'
            self.send(200, rows, headers)
            return
        if parsed.path == "/repos/acme/widget/issues/1/labels" and self.command == "POST":
            f.posts += 1
            if body is None or set(body) != {"labels"} or not isinstance(body["labels"], list):
                self.send(400, {"message": "only additive labels permitted"})
                return
            if not f.omit_label:
                f.current["labels"] += [{"name": label} for label in body["labels"]]
            if f.closed_race:
                f.current["state"] = "closed"
            self.send(200, f.current["labels"])
            return
        if parsed.path == "/repos/acme/widget/issues/1":
            self.send(200, f.current)
            return
        self.send(404, {"message": "unknown fixture path"})

    do_GET = do_POST = do_PUT = do_PATCH = handle_request


class GitHubRepositoryIssuesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def issue(self, iid=1, **changes):
        return {"id": 1000 + iid, "number": iid, "state": "open", "title": "Fixture Issue",
            "body": "Fixture description", "html_url": f"https://github.com/acme/widget/issues/{iid}",
            "repository_url": self.base + "/repos/acme/widget", "labels": [{"name": "bug"}],
            "created_at": "2026-10-23T01:00:00Z", "user": {"id": 2, "login": "Author"},
            "assignees": [{"id": 3, "login": "Assigned"}], **changes}

    def setUp(self):
        self.server.fixture = self
        self.config = {"api_url": self.base, "pullAuth": {"user": "fixture-user", "secret": "fixture-token", "kind": "token"}}
        self.expected_token = "fixture-token"
        self.requests, self.posts, self.api_error, self.errors = [], 0, 0, {}
        self.redirect, self.next_link = "", ""
        self.no_page_headers = self.endless = self.omit_label = self.closed_race = self.invalid_json = False
        self.label_creates, self.label_creation_race, self.label_not_created = 0, False, False
        self.repository_labels = {"started", "soduwork::started"}
        self.since = datetime(2026, 10, 23, 0, tzinfo=timezone.utc)
        self.until = datetime(2026, 10, 24, 0, tzinfo=timezone.utc)
        self.current = self.issue()
        self.repository = {"id": 149, "name": "widget", "full_name": "acme/widget",
            "clone_url": "https://github.com/acme/widget.git", "ssh_url": "git@github.com:acme/widget.git",
            "html_url": "https://github.com/acme/widget", "default_branch": "main", "private": True,
            "archived": False, "has_issues": True, "owner": {"id": 9, "login": "acme"}}
        self.pages = {"/repos/acme/widget/issues": [[self.issue()], [self.issue(2)]],
            "/user/repos": [[self.repository]], "/repos/acme/widget/branches": [[{"name": "main"}], [{"name": "topic/test"}]]}

    def scan(self):
        return adapter.scan(self.config, "149", self.since, self.until)

    def test_scan_normalizes_all_issue_pages_without_collaborator_snapshot(self):
        result = self.scan()
        self.assertEqual([row["iid"] for row in result["issues"]], [1, 2])
        self.assertEqual(result["issues"][0]["author"], {"id": 2, "username": "Author", "name": "Author"})
        self.assertEqual(result["issues"][0]["labels"], ["bug"])
        self.assertEqual(result["issues"][0]["state"], "opened")
        self.assertEqual(result["issues"][0]["description"], "Fixture description")
        self.assertEqual(result["members"], [])
        calls = [row for row in self.requests if row["path"].endswith("/issues")]
        self.assertEqual([row["query"]["page"] for row in calls], [["1"], ["2"]])
        self.assertFalse(any(row["path"].endswith("/collaborators") for row in self.requests))
        self.assertTrue(all(row["version"] == "2022-11-28" and row["agent"] for row in self.requests))

    def test_creation_window_filters_updated_old_future_and_pull_requests(self):
        self.pages["/repos/acme/widget/issues"] = [[self.issue(3, pull_request={}),
            self.issue(4, created_at="2026-10-22T23:59:59Z"),
            self.issue(5, created_at="2026-10-24T00:00:01Z"),
            self.issue(6, created_at="2026-10-23T00:00:00Z"),
            self.issue(7, created_at="2026-10-24T00:00:00Z", state="closed")]]
        result = self.scan()
        self.assertEqual([row["iid"] for row in result["issues"]], [6, 7])
        self.assertEqual(result["issues"][1]["state"], "closed")
        call = next(row for row in self.requests if row["path"].endswith("/issues"))
        self.assertEqual(call["query"]["since"], ["2026-10-22T23:59:59Z"])
        self.assertEqual(call["query"]["state"], ["all"])

    def test_deleted_author_and_null_body_are_supported(self):
        self.pages["/repos/acme/widget/issues"] = [[self.issue(user=None, body=None)]]
        result = self.scan()["issues"][0]
        self.assertEqual((result["author"], result["description"]), ({}, ""))

    def test_missing_pagination_headers_probe_full_pages(self):
        self.no_page_headers = True
        with patch.object(github, "_PER_PAGE", 1):
            self.assertEqual(len(self.scan()["issues"]), 2)
        self.assertIn(["3"], [row["query"].get("page") for row in self.requests])

    def test_page_limit_failure_does_not_return_partial_snapshot(self):
        self.endless = True
        with patch.object(github, "_MAX_PAGES", 2), self.assertRaisesRegex(ValueError, "page limit"):
            self.scan()

    def test_next_cursor_cannot_change_origin_path_or_filters(self):
        for target in ("https://unrelated.invalid/issues?page=2", self.base + "/unrelated?page=2",
                self.base + "/repos/acme/widget/issues?page=3"):
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, "next-page"):
                self.next_link = target
                self.scan()
        self.assertFalse(any(row["path"] == "/unrelated" for row in self.requests))

    def test_repository_and_issue_identity_mismatch_fail_closed(self):
        self.repository["id"] = 150
        with self.assertRaisesRegex(ValueError, "different repository"):
            self.scan()
        self.repository["id"] = 149
        self.pages["/repos/acme/widget/issues"] = [[self.issue(repository_url=self.base + "/repos/other/repo")]]
        with self.assertRaisesRegex(ValueError, "different repository"):
            self.scan()

    def test_malformed_and_duplicate_rows_fail_closed(self):
        for changes in ({"labels": [None]}, {"created_at": "not-time"}, {"state": "unknown"}, {"user": {"id": 0, "login": "x"}}):
            self.pages["/repos/acme/widget/issues"] = [[self.issue(**changes)]]
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.scan()
        self.pages["/repos/acme/widget/issues"] = [[self.issue()], [self.issue()]]
        with self.assertRaisesRegex(ValueError, "duplicate Issue"):
            self.scan()
    def test_issue_read_access_is_sufficient_without_collaborator_or_write_access(self):
        self.errors["/repos/acme/widget/collaborators"] = 403
        self.errors["/repos/acme/widget/labels"] = 403
        for issue_pages, count in (([[self.issue()], [self.issue(2)]], 2), ([[]], 0)):
            with self.subTest(issue_count=count):
                self.pages["/repos/acme/widget/issues"] = issue_pages
                self.requests.clear()
                result = self.scan()
                self.assertEqual(len(result["issues"]), count)
                self.assertEqual(result["members"], [])
                self.assertTrue(all(row["method"] == "GET" for row in self.requests))
                self.assertEqual({row["path"] for row in self.requests},
                    {"/repositories/149", "/repos/acme/widget/issues"})

    def test_start_only_adds_label_and_verifies_without_replacing_existing(self):
        result = adapter.started(self.config, 149, 1, "soduwork::started")
        self.assertTrue(result["ok"])
        self.assertFalse(result["already_started"])
        self.assertEqual(result["issue"]["labels"], ["bug", "soduwork::started"])
        writes = [row for row in self.requests if row["method"] != "GET"]
        self.assertEqual([(row["method"], row["path"], row["body"]) for row in writes],
            [("POST", "/repos/acme/widget/issues/1/labels", {"labels": ["soduwork::started"]})])
        self.assertEqual(self.requests[-1]["path"], "/repos/acme/widget/issues/1")
        self.assertTrue(adapter.started(self.config, 149, 1, "SoduWork::Started")["already_started"])
        self.assertEqual(self.posts, 1)

    def test_closed_issue_and_pull_request_are_never_modified(self):
        self.current["state"] = "closed"
        self.assertEqual(adapter.started(self.config, 149, 1, "started")["reason"], "issue_closed")
        self.current = self.issue(pull_request={})
        with self.assertRaisesRegex(ValueError, "pull request"):
            adapter.started(self.config, 149, 1, "started")
        self.assertEqual(self.posts, 0)
        self.assertEqual(self.label_creates, 0)

    def test_missing_label_is_created_only_at_first_start_and_not_replaced(self):
        result = adapter.started(self.config, 149, 1, "new-start")
        self.assertTrue(result["ok"])
        writes = [row for row in self.requests if row["method"] != "GET"]
        self.assertEqual([(row["path"], row["body"]) for row in writes], [
            ("/repos/acme/widget/labels", {"name": "new-start", "color": "0e8a16"}),
            ("/repos/acme/widget/issues/1/labels", {"labels": ["new-start"]})])
        self.assertTrue(adapter.started(self.config, 149, 1, "new-start")["already_started"])
        self.assertEqual((self.label_creates, self.posts), (1, 1))

    def test_label_creation_conflict_requires_read_confirmation(self):
        self.label_creation_race = True
        self.assertTrue(adapter.started(self.config, 149, 1, "new-start")["ok"])
        self.current = self.issue()
        self.label_not_created = True
        with self.assertRaises(adapter.GitHubHTTPError) as error:
            adapter.started(self.config, 149, 1, "unavailable-label")
        self.assertEqual(error.exception.code, 404)
        self.assertEqual(self.posts, 1)

    def test_label_permission_error_does_not_attempt_creation_or_issue_write(self):
        self.errors["/repos/acme/widget/labels/started"] = 403
        with self.assertRaises(adapter.GitHubHTTPError) as error:
            adapter.started(self.config, 149, 1, "started")
        self.assertEqual(error.exception.code, 403)
        self.assertEqual((self.label_creates, self.posts), (0, 0))

    def test_close_race_is_manual_and_missing_acknowledgement_retries(self):
        self.closed_race = True
        self.assertEqual(adapter.started(self.config, 149, 1, "started")["reason"], "issue_closed")
        self.closed_race, self.omit_label, self.current = False, True, self.issue()
        with self.assertRaisesRegex(ValueError, "did not confirm"):
            adapter.started(self.config, 149, 1, "started")

    def test_start_rejects_wrong_issue_and_invalid_label_before_mutation(self):
        self.current["number"] = 2
        with self.assertRaisesRegex(ValueError, "different Issue"):
            adapter.started(self.config, 149, 1, "started")
        for label in ("", " started", "x\n", "x" * 51):
            with self.subTest(label=label), self.assertRaises(ValueError):
                adapter.started(self.config, 149, 1, label)
        self.assertEqual(self.posts, 0)

    def test_current_pull_account_beats_legacy_token_and_materialized_draft_wins(self):
        self.config["token"] = "unrelated-token"
        self.scan()
        self.config.update(_auth_user="draft-user", _auth_secret="draft-token", _auth_kind="token")
        self.expected_token = "draft-token"
        self.scan()
        self.assertEqual(self.requests[-1]["auth"], "Bearer draft-token")

    def test_no_environment_credentials_or_incomplete_account_fallback(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "fixture-token", "GITLAB_TOKEN": "fixture-token"}):
            for cfg in ({"api_url": self.base}, {"api_url": self.base, "token": "fixture-token", "pullAuth": {"user": "missing-secret"}},
                    {"api_url": self.base, "token": "fixture-token", "_auth_secret": ""}):
                with self.subTest(config_keys=list(cfg)), self.assertRaises(ValueError):
                    adapter.scan(cfg, 149, self.since, self.until)
        self.assertEqual(self.requests, [])

    def test_password_and_header_injection_credentials_are_rejected(self):
        for secret, kind in (("fixture-token", "password"), ("secret\nHeader: value", "token"), ("令牌", "token")):
            self.config["pullAuth"].update(secret=secret, kind=kind)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.scan()
        self.assertEqual(self.requests, [])

    def test_explicit_current_integration_token_supported(self):
        self.config = {"api_url": self.base, "token": "fixture-token"}
        self.assertEqual(len(self.scan()["issues"]), 2)

    def test_http_errors_are_structured_and_redacted(self):
        for code in (401, 403, 404, 429, 500, 503):
            self.api_error = code
            with self.subTest(code=code), self.assertRaises(adapter.GitHubHTTPError) as error:
                self.scan()
            self.assertEqual(vars(error.exception), {"code": code})
            self.assertNotIn("fixture-token", str(error.exception))
            self.assertNotIn("sensitive", str(error.exception))
        self.api_error, self.invalid_json = 0, True
        with self.assertRaisesRegex(ValueError, "invalid JSON") as error:
            self.scan()
        self.assertNotIn("private", str(error.exception))

    def test_authenticated_redirect_cannot_escape_origin(self):
        self.redirect = "http://127.0.0.1:1/unrelated"
        with self.assertRaisesRegex(ValueError, "outside the configured origin"):
            self.scan()

    def test_invalid_boundaries_and_ids_fail_before_network(self):
        for since, until in ((self.until, self.since), (self.since.replace(tzinfo=None), self.until)):
            with self.assertRaises(ValueError):
                adapter.scan(self.config, 149, since, until)
        with self.assertRaises(ValueError):
            adapter.scan(self.config, "../../private", self.since, self.until)
        self.assertEqual(self.requests, [])

    def test_catalog_and_branches_are_paginated_with_stable_ids(self):
        other = {**self.repository, "id": 150, "name": "other", "full_name": "acme/other", "archived": True}
        self.pages["/user/repos"].append([other])
        connector = github.GitHubConnector()
        rows = connector.list_repositories(self.config)
        self.assertEqual([row["externalId"] for row in rows], ["149", "150"])
        self.assertEqual(rows[0]["cloneUrl"], self.repository["clone_url"])
        self.assertEqual(rows[0]["visibility"], "private")
        self.assertTrue(rows[1]["archived"])
        self.assertEqual(connector.list_branches(self.config, "149"), ["main", "topic/test"])

    def test_catalog_duplicate_or_invalid_identity_is_not_a_partial_success(self):
        self.pages["/user/repos"].append([deepcopy(self.repository)])
        with self.assertRaisesRegex(ValueError, "duplicate repository"):
            github.GitHubConnector().list_repositories(self.config)
        self.pages["/user/repos"] = [[{**self.repository, "full_name": "../../private"}]]
        with self.assertRaisesRegex(ValueError, "invalid repository"):
            github.GitHubConnector().list_repositories(self.config)

    def test_verify_uses_same_auth_and_does_not_expose_upstream_error(self):
        connector = github.GitHubConnector()
        self.assertTrue(connector.verify(self.config)["ok"])
        self.api_error = 401
        result = connector.verify(self.config)
        self.assertFalse(result["ok"])
        self.assertIn("401", result["detail"])
        self.assertNotIn("sensitive", result["detail"])

    def test_legacy_import_paths_remain_disabled(self):
        connector = github.GitHubConnector()
        self.assertFalse(connector.scheduled)
        self.assertEqual(connector.pull(self.config, {"old": "cursor"}), ([], {"old": "cursor"}))
        self.assertEqual(connector.parse_webhook({}, b'{"action":"opened"}'), [])
        self.assertEqual(self.requests, [])

    def test_api_base_supports_cloud_enterprise_and_explicit_api_prefix(self):
        self.assertEqual(github._api_base({}), "https://api.github.com")
        self.assertEqual(github._api_base({"base_url": "https://github.com/"}), "https://api.github.com")
        self.assertEqual(github._api_base({"base_url": "https://git.example.test"}), "https://git.example.test/api/v3")
        self.assertEqual(github._api_base({"base_url": "https://git.example.test/api/v3"}), "https://git.example.test/api/v3")
        self.assertEqual(github._api_base({"api_url": self.base}), self.base)
        for base in ("https://user:secret@github.com", "https://github.com/acme/widget", "file:///private", "https://git.example.test?secret=x"):
            with self.subTest(base=base), self.assertRaises(ValueError):
                github._api_base({"base_url": base})


if __name__ == "__main__":
    unittest.main()
