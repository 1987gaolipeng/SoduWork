"""Offline platform-pack regression: temporary files and in-memory SQLite only."""
from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile

# Override before app.db/config is imported; never use the developer's business DB.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.db import Base
from app import models, automation_models as am
from app.services import (plugin_bootstrap, plugin_catalog, plugin_conversation,
                          plugin_drafts, plugin_installations, plugin_package_resources,
                          plugin_packages, plugin_resources, plugin_service)
import build_platform_plugins as builder
from public_source import is_public_snapshot

ROOT = Path(__file__).resolve().parent
PREFIX = plugin_package_resources.PREFIX


def zip_files(data):
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        return {name: bundle.read(name) for name in bundle.namelist()}


def repack(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, data in sorted(files.items()):
            bundle.writestr(name, data)
    return output.getvalue()


def with_manifest(data, **changes):
    files = zip_files(data)
    manifest = json.loads(files["plugin.json"])
    manifest.update(changes)
    files["plugin.json"] = json.dumps(manifest, ensure_ascii=False).encode()
    return repack(files)


def resource_bytes(resources):
    return {row["path"]: base64.b64decode(row["content"]) for row in resources}


class PlatformPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.packages = {name: builder.package_bytes(name) for name in builder.PLATFORMS}

    def test_native_import_has_complete_public_resources_without_fake_workflow(self):
        for provider, data in self.packages.items():
            with self.subTest(provider=provider):
                with patch("subprocess.Popen", side_effect=AssertionError("Import must be inert")):
                    parsed = plugin_packages.parse(data)
                    public = plugin_packages.public_summary(parsed)
                self.assertEqual(parsed["sourceKind"], "soduwork")
                self.assertEqual(parsed["manifest"]["key"], provider)
                self.assertEqual(parsed["manifest"]["capabilities"]["platforms"], [provider])
                self.assertEqual(parsed["capabilities"]["platforms"], [provider])
                self.assertFalse(parsed["capabilities"]["hasWorkflow"])
                self.assertEqual(public["workflow"], {"nodes": []})
                bundle = parsed["resourceBundle"]
                expected = {PREFIX + name: value for name, value in zip_files(data).items()
                            if name != "plugin.json"}
                self.assertEqual(resource_bytes(bundle["resources"]), expected)
                self.assertEqual(public["capabilities"]["resources"],
                                 plugin_resources.summary(bundle["resources"]))
                self.assertTrue(any(row["path"] == PREFIX + f"skills/{provider}/SKILL.md"
                                    for row in bundle["skills"]))
                self.assertEqual(parsed["capabilities"]["externalSkills"], [])
                self.assertEqual(parsed["capabilities"]["mcpServers"],
                                 ["feishu"] if provider == "feishu" else [])
                self.assertFalse(parsed["manifest"]["entrypoints"]["automation"])

    def test_personal_import_export_preserves_every_file_and_hash(self):
        for provider, data in self.packages.items():
            with self.subTest(provider=provider):
                parsed = plugin_packages.parse(data)
                draft = plugin_packages.personal_draft(parsed)
                self.assertEqual(draft["resources"], parsed["resourceBundle"]["resources"])
                self.assertEqual(draft["skills"], [])
                self.assertIn(PREFIX + f"skills/{provider}/SKILL.md", draft["instructions"])
                roundtrip = plugin_packages.parse(plugin_drafts.build(draft))
                self.assertEqual(roundtrip["resources"], draft["resources"])
                self.assertEqual(resource_bytes(roundtrip["resources"]),
                                 resource_bytes(parsed["resourceBundle"]["resources"]))

    def test_personal_declared_skill_resource_still_requires_its_checksum(self):
        parsed = plugin_packages.parse(self.packages["feishu"])
        draft = plugin_packages.personal_draft(parsed)
        files = zip_files(plugin_drafts.build(draft))
        resource = next(row for row in draft["resources"] if row["path"].endswith("/SKILL.md"))
        path = "skills/feishu/" + resource["path"]
        files[path] = files[path].replace(b"---", b"xxx", 1)
        with self.assertRaisesRegex(ValueError, "校验"):
            plugin_packages.parse(repack(files))

    def test_undeclared_duplicate_skill_is_not_hidden_by_portable_resources(self):
        parsed = plugin_packages.parse(self.packages["feishu"])
        draft = plugin_packages.personal_draft(parsed)
        files = zip_files(plugin_drafts.build(draft))
        files["skills/undeclared/SKILL.md"] = files["skills/feishu/SKILL.md"]
        with self.assertRaisesRegex(ValueError, "重名技能"):
            plugin_packages.parse(repack(files))

    def test_official_release_and_source_pins_are_independent_and_reviewable(self):
        expected = {"feishu": ("@larksuiteoapi/lark-mcp", "0.5.1", "MIT"),
                    "dingtalk": ("dingtalk-workspace-cli", "1.0.61", "Apache-2.0"),
                    "wecom": ("@wecom/cli", "1.3.4", "MIT")}
        for provider, data in self.packages.items():
            with self.subTest(provider=provider):
                files = zip_files(data)
                lock = json.loads(files["upstream-lock.json"])
                self.assertEqual((lock["package"], lock["version"], lock["license"]), expected[provider])
                self.assertRegex(lock["sourceCommit"], r"^[0-9a-f]{40}$")
                self.assertRegex(lock["snapshotSha256"], r"^[0-9a-f]{64}$")
                self.assertTrue(lock["repository"].startswith("https://github.com/"))
                self.assertTrue(lock["npmTarball"].startswith("https://registry.npmjs.org/"))
                self.assertTrue(lock["npmIntegrity"].startswith("sha512-"))
                self.assertEqual(len(base64.b64decode(lock["npmIntegrity"].split("-", 1)[1])), 64)
                manifest = json.loads(files["plugin.json"])
                self.assertIn(lock["version"], manifest["openSource"]["upstreamVersion"])
                self.assertIn(lock["sourceCommit"], manifest["openSource"]["upstreamVersion"])
                self.assertIn("ADAPTATIONS.md", files)
                if provider == "dingtalk":
                    self.assertEqual(lock["sourceArtifact"], "npm package assets/dws-skills.zip")
                    self.assertRegex(lock["sourceArtifactSha256"], r"^[0-9a-f]{64}$")
                    self.assertEqual(lock["sourceCommit"], lock["runtimeSourceCommit"])

    def test_complete_upstream_inventory_and_licenses_survive_adaptation(self):
        reviewed_changes = {"skills/dingtalk-aitable/scripts/upload_attachment.py",
                            "skills/wecom-unified/SKILL.md",
                            "skills/dingtalk-drive/references/drive.md",
                            "skills/dingtalk-shared/references/recipes/conventions.md",
                            "skills/dingtalk-misc/references/dev/recipes.md"}
        for provider, data in self.packages.items():
            with self.subTest(provider=provider):
                folder = builder.SOURCES / provider
                original = zip_files((folder / "upstream.zip").read_bytes())
                lock = json.loads((folder / "upstream-lock.json").read_text(encoding="utf8"))
                files = zip_files(data)
                self.assertEqual(set(original), set(lock["upstreamFiles"]))
                self.assertTrue(set(original).issubset(files))
                for name, content in original.items():
                    self.assertEqual(hashlib.sha256(content).hexdigest(), lock["upstreamFiles"][name])
                    if name not in reviewed_changes:
                        self.assertEqual(files[name], content, name)
                licenses = [name for name in original if "LICENSE" in name]
                self.assertTrue(licenses)
                for name in licenses:
                    self.assertIn(b"Copyright", files[name])
                    self.assertEqual(files[name], original[name])
                if provider == "dingtalk":
                    self.assertIn(b"Apache License", files["licenses/dingtalk-LICENSE"])
                    self.assertEqual(files["licenses/dingtalk-NOTICE"], original["licenses/dingtalk-NOTICE"])

    def test_documented_local_file_links_resolve_inside_each_package(self):
        for provider, data in self.packages.items():
            files = zip_files(data)
            for name, content in files.items():
                if not name.endswith(".md"):
                    continue
                for link in re.findall(r"\[[^\]]*\]\(([^\s)]+)", content.decode("utf8")):
                    link = link.split("#", 1)[0]
                    if re.match(r"^[a-z][a-z0-9+.-]*:", link, re.I):
                        continue
                    if not re.search(r"\.(md|py|mjs|cjs|json|yaml|yml|sh)$", link, re.I):
                        continue
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
                    with self.subTest(provider=provider, file=name, link=link):
                        self.assertIn(target, files)

    def test_changed_apache_files_carry_notices_in_the_distributed_files(self):
        original = zip_files((builder.SOURCES / "dingtalk" / "upstream.zip").read_bytes())
        files = zip_files(self.packages["dingtalk"])
        changed = [name for name, content in original.items() if files[name] != content]
        self.assertEqual(len(changed), 3)
        for name in changed:
            with self.subTest(file=name):
                self.assertIn(b"Modified by SoduWork, 2026-10-17:", files[name][:512])
                if name.endswith(".py"):
                    compile(files[name], name, "exec")  # Parse only; never execute upstream code.
                    if original[name].startswith(b"#!"):
                        self.assertEqual(files[name].splitlines()[0], original[name].splitlines()[0])
        self.assertEqual(files["licenses/dingtalk-LICENSE"], original["licenses/dingtalk-LICENSE"])
        self.assertEqual(files["licenses/dingtalk-NOTICE"], original["licenses/dingtalk-NOTICE"])
        self.assertIn("钉钉 1.0.6", files["ADAPTATIONS.md"].decode("utf8"))

    def copy_sources(self, directory):
        source = Path(directory) / "sources"
        shutil.copytree(builder.SOURCES, source, ignore=shutil.ignore_patterns("releases"))
        return source

    def test_snapshot_tamper_is_rejected_before_packaging(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-platform-snapshot-") as directory:
            sources = self.copy_sources(directory)
            path = sources / "feishu" / "upstream.zip"
            path.write_bytes(path.read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "snapshot checksum mismatch"):
                builder.package_bytes("feishu", sources)

    def test_upstream_file_tamper_is_rejected_even_with_new_archive_checksum(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-platform-file-") as directory:
            sources = self.copy_sources(directory)
            folder = sources / "feishu"
            files = zip_files((folder / "upstream.zip").read_bytes())
            name = next(iter(files))
            files[name] += b"\nChanged upstream content"
            snapshot = repack(files)
            (folder / "upstream.zip").write_bytes(snapshot)
            lock = json.loads((folder / "upstream-lock.json").read_text(encoding="utf8"))
            lock["snapshotSha256"] = hashlib.sha256(snapshot).hexdigest()
            (folder / "upstream-lock.json").write_text(json.dumps(lock), encoding="utf8")
            with self.assertRaisesRegex(ValueError, "file checksum mismatch"):
                builder.package_bytes("feishu", sources)

    def test_missing_upstream_file_is_rejected_even_with_new_archive_checksum(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-platform-inventory-") as directory:
            sources = self.copy_sources(directory)
            folder = sources / "wecom"
            files = zip_files((folder / "upstream.zip").read_bytes())
            del files[next(iter(files))]
            snapshot = repack(files)
            (folder / "upstream.zip").write_bytes(snapshot)
            lock = json.loads((folder / "upstream-lock.json").read_text(encoding="utf8"))
            lock["snapshotSha256"] = hashlib.sha256(snapshot).hexdigest()
            (folder / "upstream-lock.json").write_text(json.dumps(lock), encoding="utf8")
            with self.assertRaisesRegex(ValueError, "inventory mismatch"):
                builder.package_bytes("wecom", sources)

    def test_build_is_deterministic_and_refuses_same_version_content_change(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-platform-build-") as directory:
            target = Path(directory)
            first = builder.build(target)
            saved = {path: path.read_bytes() for path in first}
            self.assertEqual(builder.build(target), first)
            for path, data in saved.items():
                provider = path.parent.name
                self.assertEqual(path.read_bytes(), data)
                self.assertEqual(builder.package_bytes(provider), data)
                self.assertEqual(path.stem, json.loads(zip_files(data)["plugin.json"])["version"])
            changed = dict(self.packages)
            changed["feishu"] = with_manifest(changed["feishu"], description="Changed package description")
            with patch.object(builder, "package_bytes", side_effect=changed.__getitem__):
                with self.assertRaisesRegex(ValueError, "version bump"):
                    builder.build(target)
            self.assertEqual({path: path.read_bytes() for path in first}, saved)
            self.assertEqual(list(target.rglob("*.tmp")), [])

    def test_new_version_preserves_accepted_package_paths_and_bytes(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-platform-upgrade-") as directory:
            target = Path(directory)
            first = builder.build(target)
            saved = {path: path.read_bytes() for path in first}
            updated = {name: with_manifest(data, version="9.0.0")
                       for name, data in self.packages.items()}
            with patch.object(builder, "package_bytes", side_effect=updated.__getitem__):
                second = builder.build(target)
            self.assertEqual({path: path.read_bytes() for path in first}, saved)
            self.assertEqual(len(list(target.rglob("*.soduwork-plugin"))), 6)
            for path in second:
                self.assertEqual(path.stem, "9.0.0")
                self.assertEqual(path.read_bytes(), updated[path.parent.name])

    def test_materialized_files_are_complete_inert_and_preserve_modified_copies(self):
        for provider, data in self.packages.items():
            with self.subTest(provider=provider), tempfile.TemporaryDirectory(prefix="soduwork-platform-files-") as directory:
                bundle = plugin_packages.parse(data)["resourceBundle"]
                with patch("subprocess.Popen", side_effect=AssertionError("Resource delivery must be inert")):
                    installed = plugin_resources.materialize(bundle["resources"], directory, provider)
                self.assertEqual(installed["digest"], bundle["digest"])
                root = Path(installed["directory"])
                for name, content in resource_bytes(bundle["resources"]).items():
                    self.assertEqual(root.joinpath(*name.split("/")).read_bytes(), content)
                with patch("subprocess.Popen", side_effect=AssertionError("Resource delivery must be inert")):
                    self.assertEqual(plugin_resources.materialize(bundle["resources"], directory, provider), installed)
                script = root / PREFIX / "scripts/runtime.mjs"
                modified = b"throw Error('modified script must never run')"
                trusted = zip_files(data)["scripts/runtime.mjs"]
                script.write_bytes(modified)
                with patch("subprocess.Popen", side_effect=AssertionError("Recovery must be inert")):
                    recovered = plugin_resources.materialize(bundle["resources"], directory, provider)
                self.assertEqual(recovered["directory"], installed["directory"])
                self.assertEqual(recovered["digest"], bundle["digest"])
                self.assertEqual(recovered["items"], installed["items"])
                self.assertEqual(recovered["rescued"], [PREFIX + "scripts/runtime.mjs"])
                self.assertEqual(len(recovered["backups"]), 1)
                saved = recovered["backups"][0]
                self.assertEqual(saved["path"], PREFIX + "scripts/runtime.mjs")
                self.assertTrue(saved["backup"].startswith(".local-"))
                backup = root / saved["backup"]
                self.assertTrue(backup.resolve().is_relative_to(root.resolve()))
                self.assertNotEqual(backup, script)
                self.assertEqual(backup.read_bytes(), modified)
                self.assertEqual(script.read_bytes(), trusted)
                for name, content in resource_bytes(bundle["resources"]).items():
                    self.assertEqual(root.joinpath(*name.split("/")).read_bytes(), content)
                with patch("subprocess.Popen", side_effect=AssertionError("Recovery must be inert")):
                    self.assertEqual(plugin_resources.materialize(bundle["resources"], directory, provider), installed)
                self.assertEqual(backup.read_bytes(), modified)
                altered = copy.deepcopy(bundle["resources"])
                altered[0]["content"] = base64.b64encode(b"changed resource").decode()
                with self.assertRaises(ValueError):
                    plugin_resources.normalize(altered)


class PlatformInstalledTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from tests.traceback_source_cache import snapshot_loaded_sources
        self.addCleanup(snapshot_loaded_sources())
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-platform-lifecycle-")
        self.root = Path(self.temp.name)
        self.plugins = self.root / "plugins"
        self.plugins.mkdir()
        self.latest = builder.build(self.plugins / "platforms" / "releases")
        for provider in builder.PLATFORMS:
            # The first registered 1.0.0 paths remain readable after an upgrade.
            destination = self.plugins / f"{provider}.soduwork-plugin"
            if is_public_snapshot():
                # Public source excludes historical packages. Exercise the same
                # immutable-version lifecycle with an explicitly synthetic old
                # version built from reviewed source, not a historical receipt.
                destination.write_bytes(with_manifest(builder.package_bytes(provider), version="1.0.0"))
            else:
                shutil.copyfile(ROOT / "plugins" / f"{provider}.soduwork-plugin", destination)
        self.bootstrap_path = patch.object(plugin_bootstrap, "__file__",
            str(self.root / "app" / "services" / "plugin_bootstrap.py"))
        self.bootstrap_path.start()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.session.add_all([models.OrgUnit(id="company", name="Isolated company"),
                              models.User(id="reader", username="reader", org_id="company")])
        await self.session.commit()
        await self.bootstrap()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        self.bootstrap_path.stop()
        self.temp.cleanup()

    async def bootstrap(self):
        await plugin_bootstrap.bootstrap_example(self.session, plugin_service.provenance_api)

    async def versions(self):
        return list((await self.session.execute(select(am.PluginVersion))).scalars())

    async def test_bootstrap_is_idempotent_quarantined_and_preserves_previous_versions(self):
        versions = await self.versions()
        self.assertEqual(len(versions), 6)
        original = {row.id: (row.checksum, row.package_path) for row in versions}
        for row in versions:
            self.assertEqual(row.trust_state, "quarantined")
            self.assertFalse(row.enabled)
            self.assertEqual(row.provenance["signatureState"], "platform")
            self.assertEqual(plugin_packages.parse(Path(row.package_path).read_bytes())["checksum"], row.checksum)
            self.assertTrue(plugin_package_resources.for_version(row)["resources"])
        catalog = await plugin_catalog.client_catalog(self.session, "company", user_id="reader")
        self.assertEqual(catalog["items"], [])
        await self.bootstrap()
        self.assertEqual({row.id: (row.checksum, row.package_path) for row in await self.versions()}, original)
        self.assertEqual(await self.session.scalar(select(func.count()).select_from(am.Plugin)), 3)

    async def test_bootstrap_rejects_changed_version_and_wrong_archive_identity(self):
        old = {row.id: row.checksum for row in await self.versions()}
        selected = self.latest[0]
        selected.write_bytes(with_manifest(selected.read_bytes(), description="Illegal in-place update"))
        wrong = selected.parent / "99.0.0.soduwork-plugin"
        wrong.write_bytes(self.latest[-1].read_bytes())
        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            await self.bootstrap()
        self.assertGreaterEqual(len(logs.records), 2)
        self.assertEqual({row.id: row.checksum for row in await self.versions()}, old)
        row = next(item for item in await self.versions() if Path(item.package_path) == selected)
        with self.assertRaises(ValueError):
            plugin_package_resources.for_version(row)

    async def test_revised_builtin_definitions_register_new_versions_without_replacing_acceptance(self):
        revisions = {"goal-delivery-harness": ("1.0.2", "1.0.3"),
                     "product-incubator": ("1.0.0", "1.0.1"),
                     "viral-video-studio": ("1.0.3", "1.0.4")}
        current = {}
        for key, (previous, version) in revisions.items():
            raw = json.loads((ROOT / "plugins" / f"{key}.json").read_text(encoding="utf8"))
            self.assertEqual(raw["version"], version)
            current[key] = raw
            # Synthetic previously accepted content, not a production snapshot.
            old = copy.deepcopy(raw)
            old.update(version=previous, instructions=f"Previously reviewed fixture for {key}")
            (self.plugins / f"{key}.json").write_text(json.dumps(old), encoding="utf8")
        await self.bootstrap()
        identities = {row.key: row for row in (await self.session.execute(
            select(am.Plugin).where(am.Plugin.key.in_(revisions)))).scalars()}
        installations, bindings, old_versions = [], [], []
        for key, (previous, _version) in revisions.items():
            plugin = identities[key]
            plugin.enabled = True
            old = (await self.session.execute(select(am.PluginVersion).where(
                am.PluginVersion.plugin_id == plugin.id,
                am.PluginVersion.version == previous))).scalar_one()
            old.enabled, old.trust_state = True, "approved"
            old_versions.append(old)
            installation = am.PluginInstallation(plugin_id=plugin.id, version_id=old.id,
                user_id="reader", enabled=True, config={"retained": key})
            binding = am.PluginBinding(plugin_id=plugin.id, version_id=old.id,
                org_id="company", enabled=True, config={"retained": key},
                secret_refs={"connection": "fixture-reference"})
            self.session.add_all([installation, binding])
            installations.append(installation)
            bindings.append(binding)
        await self.session.commit()

        def snapshot(row):
            return copy.deepcopy((row.version, row.checksum, row.manifest, row.workflow,
                row.capability_report, row.trust_state, row.enabled, row.package_path))

        before = {row.id: snapshot(row) for row in await self.versions()}
        for key, raw in current.items():
            (self.plugins / f"{key}.json").write_text(json.dumps(raw), encoding="utf8")
        with self.assertNoLogs("uvicorn.error", level="ERROR"):
            await self.bootstrap()
        versions = await self.versions()
        self.assertEqual(len(versions), len(before) + len(revisions))
        for row in versions:
            await self.session.refresh(row)
            if row.id in before:
                self.assertEqual(snapshot(row), before[row.id])
        for key, raw in current.items():
            new = next(row for row in versions if row.plugin_id == identities[key].id
                       and row.version == raw["version"])
            self.assertFalse(new.enabled)
            self.assertEqual(new.trust_state, "quarantined")
            self.assertEqual(new.provenance["signatureState"], "platform")
            manifest, workflow, report = plugin_packages.normalize(raw)
            self.assertEqual((new.manifest, new.workflow, new.capability_report),
                             (manifest, workflow, report))
            self.assertEqual(new.checksum, hashlib.sha256(json.dumps(
                raw, ensure_ascii=False, sort_keys=True).encode()).hexdigest())
        for index, old in enumerate(old_versions):
            for installed in (installations[index], bindings[index]):
                await self.session.refresh(installed)
                self.assertEqual(installed.version_id, old.id)
                self.assertTrue(installed.enabled)
                self.assertEqual(installed.config, {"retained": old.manifest["key"]})
            self.assertEqual(bindings[index].secret_refs, {"connection": "fixture-reference"})

        registered = {row.id: snapshot(row) for row in versions}
        await self.bootstrap()
        self.assertEqual({row.id: snapshot(row) for row in await self.versions()}, registered)
        changed = copy.deepcopy(current["product-incubator"])
        changed["instructions"] += " Changed without increasing the version."
        (self.plugins / "product-incubator.json").write_text(json.dumps(changed), encoding="utf8")
        with self.assertLogs("uvicorn.error", level="ERROR"):
            await self.bootstrap()
        after_conflict = await self.versions()
        self.assertEqual({row.id for row in after_conflict}, set(registered))
        for row in after_conflict:
            await self.session.refresh(row)
            self.assertEqual(snapshot(row), registered[row.id])

    async def test_both_archive_suffixes_discover_same_immutable_version_once(self):
        original = {row.id: row.checksum for row in await self.versions()}
        for archive in self.latest:
            self.assertEqual(archive.suffix, '.soduwork-plugin')
            archive.with_suffix('.soduwork-plugin').write_bytes(archive.read_bytes())
            archive.with_suffix('.soduwork-plugin').write_bytes(archive.read_bytes())
        paths = plugin_bootstrap.platform_archives(str(self.plugins))
        self.assertTrue(any(name.endswith('.soduwork-plugin') for name in paths))
        self.assertTrue(any(name.endswith('.soduwork-plugin') for name in paths))
        self.assertTrue(any(name.endswith('.soduwork-plugin') for name in paths))
        await self.bootstrap()
        self.assertEqual({row.id: row.checksum for row in await self.versions()}, original)

    async def test_approved_installed_platforms_resolve_complete_resources_and_revocation_blocks(self):
        latest = [row for row in await self.versions() if Path(row.package_path) in self.latest]
        for row in latest:
            await plugin_service.approve_version(self.session, row, True, "Isolated reviewer")
            await plugin_installations.install_current(self.session, "reader", row.plugin_id,
                row.id, setup=row.manifest.get("setup"))
        result = await plugin_conversation.resolve(self.session, "company",
            [row.plugin_id for row in latest], user_id="reader", include_resources=True)
        self.assertEqual(set(result["_versionIds"]), {row.id for row in latest})
        self.assertEqual(len(result["items"]), 3)
        for item in result["items"]:
            version = next(row for row in latest if row.id == item["versionId"])
            self.assertEqual(item["resourceBundle"], plugin_package_resources.for_version(version))
            self.assertIn(PREFIX + f"skills/{item['key']}/SKILL.md", item["context"])
            self.assertEqual(item["capabilities"]["skills"], [])
            self.assertEqual(item["capabilities"]["platforms"], [item["key"]])
            self.assertEqual(item["workflow"], [])
        catalog = await plugin_catalog.client_catalog(self.session, "company", user_id="reader")
        catalog_rows = {item["key"]: item for item in catalog["items"]}
        for item in result["items"]:
            self.assertEqual(catalog_rows[item["key"]]["capabilities"]["platforms"], [item["key"]])
        self.assertEqual(await self.session.scalar(select(func.count()).select_from(am.PluginBinding)), 0)
        revoked = latest[0]
        await plugin_service.approve_version(self.session, revoked, False, "Isolated reviewer")
        with self.assertRaises(ValueError):
            await plugin_conversation.resolve(self.session, "company", [revoked.plugin_id],
                                              user_id="reader", include_resources=True)
        retained = latest[1]
        await plugin_installations.uninstall(self.session, "reader", retained.plugin_id)
        with self.assertRaises(ValueError):
            await plugin_conversation.resolve(self.session, "company", [retained.plugin_id],
                                              user_id="reader", include_resources=True)

    async def test_accepted_old_version_survives_new_version_publication(self):
        versions = await self.versions()
        current = next(row for row in versions if Path(row.package_path) == self.latest[1])
        old = next(row for row in versions if row.plugin_id == current.plugin_id and row.id != current.id)
        await plugin_service.approve_version(self.session, old, True, "Isolated reviewer")
        await plugin_installations.install_current(self.session, "reader", old.plugin_id, old.id,
                                                    setup=old.manifest.get("setup"))
        before = plugin_package_resources.for_version(old)
        await plugin_service.approve_version(self.session, current, True, "Isolated reviewer")
        result = await plugin_conversation.resolve(self.session, "company", [old.plugin_id],
                                                  user_id="reader", include_resources=True)
        self.assertEqual(result["_versionIds"], [old.id])
        self.assertEqual(result["items"][0]["resourceBundle"], before)
        Path(old.package_path).write_bytes(with_manifest(Path(old.package_path).read_bytes(),
                                                       description="Tampered approved bytes"))
        with self.assertRaises(ValueError):
            await plugin_conversation.resolve(self.session, "company", [old.plugin_id],
                                              user_id="reader", include_resources=True)

    async def test_feishu_catalog_uses_current_device_connection_without_exposing_credentials(self):
        from app.services import mcp_servers
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        version = next(row for row in await self.versions()
                       if Path(row.package_path) in self.latest and row.manifest.get("key") == "feishu")
        await plugin_service.approve_version(self.session, version, True, "Isolated reviewer")
        await plugin_installations.install_current(self.session, "reader", version.plugin_id, version.id,
                                                   setup=version.manifest.get("setup"))
        endpoint = "http://127.0.0.1:39231/mcp"
        client = SimpleNamespace(mcp_enabled=[], mcp_servers=[{
            "id": "native-feishu", "name": "feishu", "type": "http", "enabled": True,
            "approved": True, "approvedTarget": endpoint, "url": endpoint,
            "headers": {"Authorization": "Bearer isolated-native-secret"}}])
        with patch.object(mcp_servers, "load", AsyncMock(return_value=[])):
            catalog = await plugin_catalog.client_catalog(self.session, "company", user_id="reader", client=client)
            item = next(item for item in catalog["items"] if item["key"] == "feishu")
            self.assertTrue(item["dependencyReadiness"]["ok"])
            self.assertNotIn("isolated-native-secret", json.dumps(catalog))
            client.mcp_servers = []
            missing = await plugin_catalog.client_catalog(self.session, "company", user_id="reader", client=client)
            self.assertFalse(next(item for item in missing["items"] if item["key"] == "feishu")["dependencyReadiness"]["ok"])


if __name__ == "__main__":
    unittest.main()
