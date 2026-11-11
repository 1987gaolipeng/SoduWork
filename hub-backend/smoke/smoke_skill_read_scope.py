"""Selected skill packages are readable, never a writable/executable grant."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from app.services import access_policy, access_scope, acp_access, access_broker
from app.services import skill_read_scope as scopes, skills, runner_skills, local_base
from app.services.acp_bridge import AcpBridge, BridgeError


class SkillScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-skill-read-")
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.work.mkdir()
        self.package = self.root / ".agents" / "skills" / "enabled"
        self.other = self.root / ".agents" / "skills" / "disabled"
        for root in (self.package, self.other):
            (root / "references").mkdir(parents=True)
            (root / "SKILL.md").write_text("---\nname: enabled\ndescription: fixture\n---\nSkill fixture", encoding="utf-8")
            (root / "references" / "guide.md").write_text("Companion guide", encoding="utf-8")
        for name in (".env", "auth.json", "credentials.json", "private.pem"):
            (self.package / name).write_text("fixture-only", encoding="utf-8")
        self.catalog = [{"name": "enabled", "path": str(self.package), "description": "fixture"},
                        {"name": "disabled", "path": str(self.other), "description": "fixture"}]
        self.scan = patch.object(skills, "scan_cached", return_value=self.catalog)
        self.scan.start()
        self.selected = scopes.localize([{"name": "enabled", "path": str(self.root)}])
        self.scope = scopes.ReadScope.skills(self.selected)
        self.links = []
        self.policy = access_policy.normalize({"schema": access_policy.SCHEMA,
            "mode": "standard", "revision": 1, "workspaceRoot": str(self.work)})

    def tearDown(self):
        for path in reversed(self.links):
            if os.path.lexists(path):
                if os.name == "nt":
                    os.rmdir(path)
                else:
                    Path(path).unlink()
        self.scan.stop()
        self.temp.cleanup()

    def link(self, path, target):
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(path), str(target)],
                           check=True, stdout=subprocess.DEVNULL, creationflags=0x08000000)
        else:
            path.symlink_to(target, target_is_directory=True)
        self.links.append(path)

    def bridge(self, agent="qwen", scope=None, mode="standard"):
        policy = {**self.policy, "mode": mode}
        wire = json.dumps({"url": "http://127.0.0.1:1", "token": "fixture-only",
                           "policy": policy, "readScope": (scope or self.scope).payload()})
        with patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": wire}):
            bridge = AcpBridge([], str(self.work), agent, "workspace", allow_terminal=True)
        requests = []
        bridge.access.call = lambda route, data: requests.append(data) or {"decision": "deny"}
        return bridge, requests

    def test_selection_ignores_injected_paths_and_unselected_catalog_packages(self):
        self.assertEqual(self.selected[0]["path"], str(self.package))
        self.assertTrue(self.scope.allows(str(self.work), str(self.package / "SKILL.md")))
        self.assertFalse(self.scope.allows(str(self.work), str(self.other / "SKILL.md")))
        self.assertEqual(scopes.localize([{"name": "unknown", "path": str(self.root)}]), [])
        self.assertEqual(scopes.ReadScope.skills([{"path": str(self.root)}]).payload(), [])
        package = {**self.catalog[0], "bundled": True, "packageChecksum": "b" * 64}
        selected = scopes.localize([{**package, "path": str(self.root)}], catalog=[package])
        self.assertEqual(selected[0]["path"], str(self.package))
        self.assertEqual(scopes.localize([{**package, "packageChecksum": "a" * 64}], catalog=[package]), [])

    def test_all_acp_agents_read_selected_skill_and_companions_without_approval(self):
        for agent in ("opencode", "codex-harness", "qwen"):
            with self.subTest(agent=agent):
                bridge, requests = self.bridge(agent)
                try:
                    for path in (self.package / "SKILL.md", self.package / "references" / "guide.md"):
                        self.assertTrue(bridge.access.native_permission({"toolCall": {
                            "kind": "read", "rawInput": {"filePath": str(path)},
                            "locations": [{"path": str(path)}]}}))
                        self.assertTrue(bridge._read_text_file({"path": str(path)})["content"])
                    self.assertEqual(requests, [])
                finally:
                    bridge.close()

    def test_sensitive_sibling_multipath_and_write_operations_still_require_approval(self):
        bridge, requests = self.bridge()
        try:
            denied = [self.other / "SKILL.md", self.root / ".agents" / "settings.json"]
            denied += [self.package / name for name in (".env", "auth.json", "credentials.json", "private.pem")]
            for path in denied:
                with self.subTest(path=path.name), self.assertRaises(acp_access.AccessError):
                    bridge._read_text_file({"path": str(path)})
            self.assertFalse(bridge.access.native_permission({"toolCall": {"kind": "read",
                "rawInput": {"path": str(self.package / "SKILL.md")},
                "locations": [{"path": str(self.other / "SKILL.md")}]}}))
            with self.assertRaises(acp_access.AccessError):
                bridge._write_text_file({"path": str(self.package / "references" / "guide.md"), "content": "changed"})
            self.assertEqual((self.package / "references" / "guide.md").read_text(), "Companion guide")
            self.assertEqual(len(requests), len(denied) + 2)
        finally:
            bridge.close()

    def test_scope_is_readable_in_readonly_mode_but_not_writable(self):
        bridge, requests = self.bridge(mode="readonly")
        try:
            self.assertTrue(bridge._read_text_file({"path": str(self.package / "SKILL.md")})["content"])
            with self.assertRaises(BridgeError):
                bridge._write_text_file({"path": str(self.package / "SKILL.md"), "content": "changed"})
            self.assertEqual(requests, [])
        finally:
            bridge.close()

    def test_package_link_escape_and_root_replacement_fail_closed(self):
        self.link(self.package / "escape", self.other)
        self.assertFalse(self.scope.allows(str(self.work), str(self.package / "escape" / "SKILL.md")))
        alias = self.root / "selected-link"
        self.link(alias, self.package)
        pinned = scopes.ReadScope.capture([str(alias)])
        self.assertTrue(pinned.allows(str(self.work), str(alias / "SKILL.md")))
        if os.name == "nt":
            os.rmdir(alias)
        else:
            alias.unlink()
        self.link(alias, self.other)
        self.assertFalse(pinned.allows(str(self.work), str(alias / "SKILL.md")))

    def test_controlled_cat_reads_resources_without_granting_script_execution(self):
        bridge, requests = self.bridge()
        try:
            path = self.package / "references" / "guide.md"
            result = bridge._terminal_create({"command": "cat", "args": [str(path)], "cwd": str(self.work)})
            self.assertEqual(bridge._terminal(result).wait()["exitCode"], 0)
            self.assertEqual(requests, [])
            self.assertEqual(bridge.access.terminal_program("python", [str(path)], str(self.work), []), "")
            self.assertEqual(bridge.access.terminal_program("cat", [str(self.package / ".env")], str(self.work), []), "")
            self.assertFalse(access_scope.automatic_query(str(self.work), "cat", args=[str(path), str(self.other / "SKILL.md")], read_scope=self.scope))
        finally:
            bridge.close()

    def test_permission_recovery_keeps_scope_but_new_selection_revokes_old_package(self):
        run = {"skillSelection": self.selected, "_skillReadScope": self.scope}
        scopes.for_run(run, {"skillSelection": [{"name": "disabled"}]}, recovery=True)
        self.assertIs(run["_skillReadScope"], self.scope)
        scopes.for_run(run, {"skillSelection": [{"name": "disabled"}]})
        self.assertFalse(run["_skillReadScope"].allows(str(self.work), str(self.package / "SKILL.md")))
        self.assertTrue(run["_skillReadScope"].allows(str(self.work), str(self.other / "SKILL.md")))
        scopes.for_run(run, {"skillSelection": []})
        self.assertEqual(run["_skillReadScope"].payload(), [])

    def test_verified_bundle_survives_metadata_reload_without_trusting_its_supplied_path(self):
        with patch.object(local_base, "_data_root", return_value=str(self.root / "runtime")), \
             patch.object(runner_skills, "_data_root", return_value=str(self.root / "runtime")):
            body = runner_skills.build([{**self.catalog[0], "bundled": True, "packageChecksum": "a" * 64}])
            rows = runner_skills.install(body)
            self.assertIsInstance(rows[0], scopes.TrustedSkill)
            saved = json.loads(json.dumps(rows))
            saved[0]["path"] = str(self.root)
            restored = scopes.localize(saved)
            self.assertEqual(restored[0]["path"], rows[0]["path"])
            self.assertFalse(scopes.ReadScope.skills(restored).allows(str(self.work), str(self.other / "SKILL.md")))
            self.assertTrue(scopes.ReadScope.skills(restored).allows(str(self.work), str(Path(rows[0]["path"]) / "SKILL.md")))

    def test_private_channel_uses_runtime_scope_not_public_policy_or_cfg_root_injection(self):
        ref = "skill-read-fixture"
        run = {"state": "running", "accessPolicy": self.policy, "skillSelection": self.selected,
               "_skillReadScope": self.scope}
        with patch.dict(local_base._RUNS, {ref: run}):
            env = {}
            try:
                access_broker.attach(ref, {"accessPolicy": self.policy, "local_cli": "qwen",
                    "readScope": [{"path": str(self.root)}], "_skillReadScope": {"path": str(self.root)}}, env)
                wire = json.loads(env["SODUWORK_APPROVAL_CHANNEL"])
                self.assertEqual(wire["readScope"], self.scope.payload())
                self.assertNotIn("readScope", wire["policy"])
            finally:
                access_broker.close(ref)

    def test_materialized_resource_scope_is_exact_and_revoked_on_the_next_turn(self):
        from app.services import plugin_resources
        bundle = plugin_resources.materialize([{"path": "references/help.md", "kind": "reference",
            "encoding": "utf8", "content": "A safe reference"}], str(self.work), "sample-plugin")
        directory = Path(bundle["directory"])
        run = {"_skillReadScope": self.scope, "skillSelection": self.selected,
               "_resourceReadScope": scopes.ReadScope.capture([str(directory)])}
        target = str(directory / "references" / "help.md")
        self.assertTrue(scopes.channel_scope(run).allows(str(self.work), target))
        self.assertFalse(scopes.channel_scope(run).allows(str(self.work), str(directory.parent / "other" / "help.md")))
        scopes.for_run(run, recovery=True)
        self.assertTrue(scopes.channel_scope(run).allows(str(self.work), target))
        scopes.for_run(run)
        self.assertFalse(scopes.channel_scope(run).allows(str(self.work), target))


    def test_workspace_contained_skill_companions_are_still_readonly_grants(self):
        package = self.work / "skill-package"
        package.mkdir()
        (package / "SKILL.md").write_text("Skill", encoding="utf-8")
        (package / "guide.md").write_text("Keep this source", encoding="utf-8")
        (package / "auth.json").write_text("fixture-only", encoding="utf-8")
        scope = scopes.ReadScope.skills(scopes.trusted([{"path": str(package)}]))
        bridge, requests = self.bridge(scope=scope)
        try:
            target = str(package / "guide.md")
            self.assertEqual(bridge._read_text_file({"path": target})["content"], "Keep this source")
            self.assertFalse(bridge.access.native_permission({"toolCall": {"kind": "edit",
                "rawInput": {"path": target, "content": "new"}}}))
            with self.assertRaises(acp_access.AccessError):
                bridge._write_text_file({"path": target, "content": "new"})
            self.assertEqual((package / "guide.md").read_text(), "Keep this source")
            secret = str(package / "auth.json")
            self.assertFalse(bridge.access.native_permission({"toolCall": {"kind": "read",
                "rawInput": {"path": secret}}}))
            with self.assertRaises(acp_access.AccessError):
                bridge._read_text_file({"path": secret})
            self.assertEqual(bridge.access.terminal_program("cat", [secret], str(self.work), []), "")
            self.assertEqual(len(requests), 4)
        finally:
            bridge.close()

    def test_resource_bytes_are_verified_and_only_the_current_bundle_is_admitted(self):
        from app.services import plugin_resources
        items = plugin_resources.normalize([{"path": "references/help.md", "kind": "reference",
            "encoding": "utf8", "content": "Resource body"}])
        bundle = {"pluginId": "personal:sample-plugin", "key": "sample-plugin",
                  "digest": plugin_resources.digest(items), "resources": items,
                  "directory": str(self.root)}  # Caller path is deliberately ignored.
        run = {"ws": str(self.work), "skillSelection": self.selected}
        scopes.for_run(run, {"skillSelection": self.selected, "pluginResourceBundles": [bundle]})
        target = self.work / ".soduwork" / "plugins" / bundle["key"] / bundle["digest"] / "references" / "help.md"
        self.assertEqual(target.read_text(), "Resource body")
        self.assertTrue(scopes.channel_scope(run).allows(str(self.work), str(target)))
        self.assertFalse(scopes.channel_scope(run).allows(str(self.work), str(self.root / "arbitrary.txt")))
        scopes.for_run(run, {"pluginResourceBundles": []})
        self.assertFalse(scopes.channel_scope(run).allows(str(self.work), str(target)))

    def test_invalid_resource_digest_path_or_secret_never_grants_a_scope(self):
        for resources, digest in (([{"path": "references/help.md", "kind": "reference", "encoding": "utf8", "content": "safe"}], "0" * 64),
                                  ([{"path": "../escape.md", "kind": "reference", "encoding": "utf8", "content": "safe"}], "0" * 64),
                                  ([{"path": "references/private.key", "kind": "reference", "encoding": "utf8", "content": "safe"}], "0" * 64)):
            with self.assertRaises(ValueError):
                scopes.materialize_bundles([{"key": "sample-plugin", "resources": resources, "digest": digest}], str(self.work))
        self.assertFalse((self.work / ".soduwork").exists())


    def test_opencode_native_external_and_metadata_only_read_use_the_same_exact_call(self):
        # OpenCode 1.18.18 acp/permission.ts forwards permission metadata. A
        # native read first asks external_directory(filepath,parentDir), then
        # read({}); neither event contains the original filePath argument.
        for mode in ("standard", "readonly"):
            bridge, requests = self.bridge("opencode", mode=mode)
            try:
                target = str(self.package / "references" / "guide.md")
                parent = str(self.package / "references")
                gate = {"toolCall": {"toolCallId": "read-current", "kind": "other",
                    "rawInput": {"filepath": target, "parentDir": parent},
                    "locations": [{"path": target}, {"path": parent}]}}
                self.assertTrue(bridge.access.native_permission(gate))
                read = {"toolCall": {"toolCallId": "read-current", "kind": "read", "rawInput": {}, "locations": []}}
                self.assertTrue(bridge.access.native_permission(read))
                self.assertEqual(requests, [])
                self.assertEqual(acp_access.opencode_permissions(mode, selected_resources=True)["external_directory"], "ask")
                self.assertFalse(bridge.access.native_permission({"toolCall": {**read["toolCall"], "toolCallId": "different"}}))
                bridge.access.observe_tool({"sessionUpdate": "tool_call_update", "toolCallId": "read-current", "status": "completed"})
                self.assertFalse(bridge.access.native_permission(read))
                bad = {"toolCall": {**gate["toolCall"], "rawInput": {"filepath": str(self.other / "SKILL.md"), "parentDir": str(self.other)}, "locations": []}}
                self.assertFalse(bridge.access.native_permission(bad))
                self.assertFalse(bridge.access.native_permission({"toolCall": {**gate["toolCall"], "rawInput": {"filepath": target, "parentDir": str(self.root)}}}))
                self.assertFalse(bridge.access.native_permission({"toolCall": {"toolCallId": "read-current", "kind": "edit", "rawInput": {"filePath": target, "content": "changed"}}}))
            finally:
                bridge.close()

    def test_opencode_metadata_only_read_uses_live_inputs_and_drops_stale_or_changed_calls(self):
        bridge, requests = self.bridge("opencode")
        try:
            update = {"sessionUpdate": "tool_call", "toolCallId": "same-call", "kind": "read", "status": "pending",
                "rawInput": {"filePath": str(self.package / "SKILL.md"), "limit": 2000}}
            read = {"toolCall": {"toolCallId": "same-call", "kind": "read", "rawInput": {}, "locations": []}}
            with patch("app.services.acp_bridge._emit"):
                bridge._update(update)
            self.assertTrue(bridge.access.native_permission(read))
            self.assertEqual(requests, [])
            bridge.access.observe_tool({**update, "sessionUpdate": "tool_call_update", "rawInput": {"filePath": str(self.package / "auth.json")}})
            self.assertFalse(bridge.access.native_permission(read))
            bridge.access.observe_tool({**update, "sessionUpdate": "tool_call_update", "kind": "execute", "rawInput": {"command": "cat anything"}})
            self.assertFalse(bridge.access.native_permission(read))
            bridge.access.observe_tool(update)
            with patch("app.services.acp_bridge._emit"):
                bridge._update({"sessionUpdate": "tool_call_update", "toolCallId": "same-call", "status": "failed"})
            self.assertFalse(bridge.access.native_permission(read))
        finally:
            bridge.close()

    def test_real_prepare_resume_revokes_previous_plugin_bytes_and_retains_only_explicit_skills(self):
        from app.services import plugin_resources, local_ctx, local_stream
        items = plugin_resources.normalize([{"path": "references/help.md", "kind": "reference", "encoding": "utf8", "content": "Resource"}])
        bundles = [{"key": "sample-plugin", "resources": items, "digest": plugin_resources.digest(items)}]
        ref = "skill-resume-fixture"
        run = {"cli": "qwen", "cliSid": "native-fixture", "ws": str(self.work), "state": "idle",
               "mode": "work", "accessPolicy": self.policy, "skillSelection": self.selected,
               "cfg": {"pluginResourceBundles": bundles}}
        scopes.for_run(run, {"skillSelection": self.selected, "pluginResourceBundles": bundles})
        resource = str(self.work / ".soduwork" / "plugins" / "sample-plugin" / bundles[0]["digest"] / "references" / "help.md")
        self.assertTrue(scopes.channel_scope(run).allows(str(self.work), resource))
        scope = run["_skillReadScope"]
        with patch.dict(local_base._RUNS, {ref: run}), patch.dict(local_ctx._PROFILES, {"qwen": {"bin": lambda: "fixture-cli", "resume": lambda *_: []}}), \
             patch.object(local_ctx, "_save_meta"), patch.object(local_stream, "_spawn"):
            self.assertTrue(local_ctx.prepare_resume(ref, "internal continuation", {}, recovery=True)["ok"])
            self.assertIs(run["_skillReadScope"], scope)
            self.assertTrue(scopes.channel_scope(run).allows(str(self.work), resource))
            self.assertTrue(local_ctx.prepare_resume(ref, "new ordinary turn", {})["ok"])
            self.assertFalse(scopes.channel_scope(run).allows(str(self.work), resource))
            self.assertTrue(scopes.channel_scope(run).allows(str(self.work), str(self.package / "SKILL.md")))
            self.assertTrue(local_ctx.prepare_resume(ref, "deselect", {"skillSelection": []})["ok"])
            self.assertFalse(scopes.channel_scope(run).allows(str(self.work), str(self.package / "SKILL.md")))


if __name__ == "__main__":
    unittest.main()
