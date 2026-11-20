from __future__ import annotations

import copy
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import client_packages as packages
import build
import hashlib
import json
from test_release_notes import example_record
from release import expected, fingerprint, write


class ClientPackagesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "client/main").mkdir(parents=True)
        shutil.copyfile(packages.ROOT / "client/main/default-hub.cjs", self.root / "client/main/default-hub.cjs")
        write(self.root / "client/package.json", {"version": "1.13.19"})
        self.env = {**os.environ, "GITHUB_REPOSITORY": "example/project", "PUBLIC_RELEASE_REPOSITORY": "example/project",
                    "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/build-default-hub-1.13.19",
                    "GITHUB_REF_PROTECTED": "true", "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123",
                    "SODUWORK_ARTIFACT_LABEL": "cn", "SODUWORK_DEFAULT_HUB_URL": "https://hub.example.test/"}
        self.ctx = packages.package_context(self.env, self.root)

    def test_default_and_custom_builds_keep_product_version_and_source_identity(self):
        self.assertEqual(self.ctx["defaultHubUrl"], "https://hub.example.test")
        self.assertEqual(self.ctx["artifactLabel"], "cn")
        self.assertEqual(self.ctx["version"], "1.13.19")
        self.assertEqual(self.ctx["commit"], "a" * 40)
        for value in [None, ""]:
            env = {**self.env, "SODUWORK_DEFAULT_HUB_URL": value}
            if value is None:
                del env["SODUWORK_DEFAULT_HUB_URL"]
            self.assertEqual(packages.package_context(env, self.root)["defaultHubUrl"], "https://service.soduwork.ai")
        self.assertNotIn("tag", self.ctx)

    def test_untrusted_build_identity_labels_and_urls_fail(self):
        for key, value in [("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF_PROTECTED", "false"),
                           ("PUBLIC_RELEASE_REPOSITORY", "other/repo"), ("GITHUB_REF", "refs/tags/v1.13.19"),
                           ("GITHUB_SHA", "short"), ("GITHUB_RUN_ID", "0"), ("SODUWORK_ARTIFACT_LABEL", "../cn"),
                           ("SODUWORK_ARTIFACT_LABEL", "cn\ncommand"), ("SODUWORK_ARTIFACT_LABEL", ""),
                           ("SODUWORK_DEFAULT_HUB_URL", "https://user:secret@hub.example.test"),
                           ("SODUWORK_DEFAULT_HUB_URL", "https://hub.example.test/api")]:
            with self.subTest(key=key), self.assertRaises(ValueError) as caught:
                packages.package_context({**self.env, key: value}, self.root)
            self.assertNotIn("secret", str(caught.exception))

    def test_existing_binary_review_and_reviewer_gate_are_required(self):
        for rules, success in [([], False), ([{"type": "required_reviewers", "reviewers": []}], False),
                               ([{"type": "required_reviewers", "reviewers": [{"type": "User"}]}], True)]:
            def api(route):
                return {"private": False} if route == "" else {"protection_rules": rules}
            with patch.object(packages, "api", side_effect=api), patch.object(packages, "policy") as policy:
                if success:
                    packages.preflight(self.ctx, self.root)
                    policy.assert_called_once_with(self.ctx, self.root)
                else:
                    with self.assertRaisesRegex(ValueError, "required reviewers"):
                        packages.preflight(self.ctx, self.root)

    def candidate(self):
        folder = self.root / "packages"
        folder.mkdir()
        for name in expected(self.ctx, "windows"):
            (folder / name).write_bytes(b"synthetic accepted installer")
        checks = {"ok": True, "sourceCommit": self.ctx["commit"], "pipelineId": self.ctx["runId"],
                  "defaultHubUrl": self.ctx["defaultHubUrl"], "bundledReleaseHistorySha256": "b" * 64,
                  "publishedReleaseNotes": {"version": self.ctx["version"], "sourceCommit": "c" * 40,
                                            "runId": "120", "sha256": "d" * 64, "manifestSha256": "e" * 64},
                  "artifacts": [fingerprint(p) for p in folder.iterdir()]}
        return folder, checks

    def test_receipt_retains_original_installer_names_and_deployment_identity(self):
        folder, checks = self.candidate()
        result = packages.record_packages(self.ctx, "windows", folder, checks)
        self.assertTrue(result["deploymentRequired"])
        self.assertEqual(result["artifacts"][0]["name"], "SoduWork-1.13.19-Setup.exe")
        self.assertEqual(result["defaultHubUrl"], self.ctx["defaultHubUrl"])
        self.assertTrue((folder / "client-packages.json").is_file())

    def test_other_environment_build_or_replaced_bytes_cannot_be_registered_as_accepted(self):
        folder, checks = self.candidate()
        for key, value in [("ok", False), ("sourceCommit", "b" * 40), ("pipelineId", "124"),
                           ("defaultHubUrl", "https://other.example.test"), ("bundledReleaseHistorySha256", ""),
                           ("publishedReleaseNotes", {})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                packages.record_packages(self.ctx, "windows", folder, {**checks, key: value})
        original = copy.deepcopy(checks)
        (folder / expected(self.ctx, "windows")[0]).write_bytes(b"replaced installer")
        with self.assertRaisesRegex(ValueError, "different installer bytes"):
            packages.record_packages(self.ctx, "windows", folder, original)
        self.assertFalse((folder / "client-packages.json").exists())

    def test_linux_packages_still_require_signing_acceptance(self):
        folder, checks = self.candidate()
        with self.assertRaisesRegex(ValueError, "Linux package signing"):
            packages.record_packages(self.ctx, "linux", folder, checks)

    def test_on_demand_native_build_preserves_prepared_release_history(self):
        folder, checks = self.candidate()
        history = self.root / "client/main/release-history.json"
        history.write_bytes(b'{"versions":[]}\n')
        write(self.root / "tools/ci/soduwork-acceptance-baselines.json", {})
        write(self.root / "release-evidence/windows/acceptance.json", checks)
        dist = self.root / "client/dist"
        dist.mkdir()
        name = expected(self.ctx, "windows")[0]
        shutil.move(folder / name, dist / name)
        with patch.object(build, "ROOT", self.root), patch.object(build, "package_native", return_value={}), \
                patch.object(build, "first_release", return_value=True), patch.object(build, "run"), \
                patch("release_notes.bundle") as bundle:
            result = build.native(self.ctx, "windows", folder, self.root, preserve_release_history=True)
        bundle.assert_not_called()
        self.assertEqual(result["bundledReleaseHistorySha256"], hashlib.sha256(history.read_bytes()).hexdigest())
        self.assertNotIn("releaseNotesSha256", result)
        self.assertEqual((folder / name).read_bytes(), (dist / name).read_bytes())

    def published_inputs(self):
        folder = self.root / "published"
        record = example_record()
        record.update(version=self.ctx["version"], runId="120")
        write(folder / "release-notes.json", record)
        manifest = {**self.ctx, "commit": record["sourceCommit"], "runId": record["runId"],
                    "tag": "v" + self.ctx["version"], "component": "all",
                    "assets": [fingerprint(folder / "release-notes.json")]}
        write(folder / "release-manifest.json", manifest)
        return folder, record, manifest

    def test_published_notes_reuse_original_prose_and_provenance_without_claiming_original_build(self):
        folder, record, manifest = self.published_inputs()
        history = self.root / "client/main/release-history.json"
        write(history, {"schema": 1, "releases": [{"version": "1.0.0", "notes": ["Older notes"]}]})
        result = packages.bundle_published_notes(self.ctx, folder, self.root)
        self.assertEqual(result["runId"], "120")
        self.assertEqual(self.ctx["runId"], "123")
        self.assertEqual(result["sha256"], manifest["assets"][0]["sha256"])
        bundled = json.loads(history.read_text())["releases"]
        self.assertEqual(bundled[0]["version"], self.ctx["version"])
        self.assertEqual(bundled[0]["locales"], record["locales"])
        self.assertEqual(bundled[1]["version"], "1.0.0")

    def test_wrong_version_or_replaced_published_notes_fail_closed(self):
        folder, record, manifest = self.published_inputs()
        for key, value in [("version", "1.0.0"), ("repository", "other/repo"), ("commit", "f" * 40),
                           ("runId", "121"), ("tag", "v1.0.0")]:
            write(folder / "release-manifest.json", {**manifest, key: value})
            with self.subTest(key=key), self.assertRaises(ValueError):
                packages.verify_published_notes(self.ctx, folder)
        write(folder / "release-manifest.json", manifest)
        (folder / "release-notes.json").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "differ"):
            packages.verify_published_notes(self.ctx, folder)

    def test_unavailable_published_notes_preserve_the_same_history_without_inventing_notes(self):
        folder, record, manifest = self.published_inputs()
        record.update(status="unavailable", locales={}, sources=[], omitted=[])
        write(folder / "release-notes.json", record)
        manifest["assets"] = [fingerprint(folder / "release-notes.json")]
        write(folder / "release-manifest.json", manifest)
        history = self.root / "client/main/release-history.json"
        original = b'{"schema":1,"releases":[]}\n'
        history.write_bytes(original)
        packages.bundle_published_notes(self.ctx, folder, self.root)
        self.assertEqual(history.read_bytes(), original)

    def test_fetch_requires_stable_release_and_pinned_published_asset_bytes(self):
        folder, _, _ = self.published_inputs()
        release = {"tag_name": "v" + self.ctx["version"], "draft": False, "prerelease": False,
                   "assets": [{"name": p.name, "digest": "sha256:" + fingerprint(p)["sha256"],
                               "browser_download_url": "https://github.com/example/project/releases/download/v" +
                                                       self.ctx["version"] + "/" + p.name} for p in folder.iterdir()]}
        target = self.root / "download"
        def download(url, file, digest):
            self.assertEqual(fingerprint(folder / file.name)["sha256"], digest)
            shutil.copyfile(folder / file.name, file)
        with patch.object(packages, "api", return_value=release), patch.object(packages, "download", side_effect=download):
            packages.fetch_published_notes(self.ctx, target)
        self.assertEqual(packages.verify_published_notes(self.ctx, target)["runId"], "120")
        for flag in ["draft", "prerelease"]:
            with patch.object(packages, "api", return_value={**release, flag: True}), self.assertRaises(ValueError):
                packages.fetch_published_notes(self.ctx, self.root / flag)
        for index in range(len(release["assets"])):
            invalid = copy.deepcopy(release)
            invalid["assets"][index]["digest"] = ""
            with patch.object(packages, "api", return_value=invalid), \
                    patch.object(packages, "download", side_effect=download), self.assertRaisesRegex(ValueError, "digest"):
                packages.fetch_published_notes(self.ctx, self.root / ("invalid-" + str(index)))

    def test_workflow_only_uploads_actions_artifacts_and_reuses_native_quality_gates(self):
        workflow = (packages.ROOT / ".github/workflows/client-packages.yml").read_text()
        for text in ["workflow_dispatch:", "environment: public-release", "needs: [preflight, quality, security]",
                     "./.github/workflows/ci.yml", "./.github/workflows/security.yml", "inputs.default_hub_url",
                     "actions/upload-artifact@", "client-${{ needs.preflight.outputs.version }}-${{ needs.preflight.outputs.label }}"]:
            self.assertIn(text, workflow)
        for text in ["contents: write", "release.py draft", "RELEASE_PASSWORD"]:
            self.assertNotIn(text, workflow)
        for line in workflow.splitlines():
            if "run:" in line:
                self.assertNotIn("inputs.", line)


if __name__ == "__main__":
    unittest.main()
