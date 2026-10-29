"""Version-specific conversation resource authorization for JSON-manifest built-ins and corrupt
packages.
"""
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import zipfile

os.environ.setdefault("AUTH_SECRET", "isolated-plugin-package-resources-test-secret")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import plugin_package_resources, plugin_packages
from app.services import plugin_resources


def _version(package_path, capability_report=None, checksum=""):
    return SimpleNamespace(package_path=package_path,
                           capability_report=capability_report or {},
                           checksum=checksum, manifest={}, provenance={},
                           created_by="member")


def _empty_digest():
    return plugin_resources.digest([])


def _valid_zip_bytes() -> tuple[bytes, str]:
    """Build the smallest SoduWork plugin package accepted by plugin_packages.parse."""
    manifest = {
        "schemaVersion": 1, "key": "demo-plugin", "version": "1.0.0",
        "name": "演示插件", "instructions": "按说明完成当前任务。",
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("plugin.json", json.dumps(manifest, ensure_ascii=False))
    data = buffer.getvalue()
    return data, plugin_packages.parse(data)["checksum"]


def _builtin_version(path):
    # Mirror the persisted bootstrap identity; a filename alone is not proof of origin.
    version = _version(str(path))
    version.manifest = {"key": "document-studio", "instructions": "Stored immutable method"}
    version.created_by = "system"
    version.provenance = {"publisherType": "platform", "channel": "builtin",
                          "signatureState": "platform", "sourceKind": "builtin",
                          "sourceName": "document-studio.json"}
    return version


class JsonManifestPluginTests(unittest.TestCase):
    def test_json_manifest_without_resources_returns_empty_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "document-studio.json"
            # The released source can have a newer version than the approved DB row.
            source = Path(__file__).resolve().parents[1] / "plugins" / path.name
            path.write_bytes(source.read_bytes())
            version = _builtin_version(path)
            bundle = plugin_package_resources.for_version(version)
            self.assertEqual(
                bundle,
                {"resources": [], "skills": [], "digest": _empty_digest()})
            self.assertEqual(version.manifest["instructions"], "Stored immutable method")

    def test_json_manifest_with_bundled_skills_still_raises(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "document-studio.json"
            path.write_text('{"instructions":"method"}', encoding="utf-8")
            version = _builtin_version(path)
            version.capability_report = {
                "bundledSkills": [{"name": "s", "archivePath": "a/SKILL.md"}]}
            with self.assertRaises(ValueError):
                plugin_package_resources.for_version(version)

    def test_resource_declarations_in_manifest_or_report_never_downgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "document-studio.json"
            path.write_text('{"instructions":"method"}', encoding="utf-8")
            for container in ("manifest", "capability_report"):
                for field in ("resources", "runtimeResources", "bundledSkills"):
                    with self.subTest(container=container, field=field):
                        version = _builtin_version(path)
                        getattr(version, container)[field] = [{"path": "scripts/run.py"}]
                        with self.assertRaises(ValueError):
                            plugin_package_resources.for_version(version)

    def test_json_suffix_requires_complete_builtin_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "document-studio.json"
            path.write_text('{"instructions":"method"}', encoding="utf-8")
            variants = [("created_by", "member"), ("key", "unknown-method"),
                        ("publisherType", "member"), ("channel", "upload"),
                        ("signatureState", "unsigned"), ("sourceKind", "upload"),
                        ("sourceName", "other-method.json")]
            for field, value in variants:
                with self.subTest(field=field):
                    version = _builtin_version(path)
                    if field == "created_by":
                        version.created_by = value
                    elif field == "key":
                        version.manifest[field] = value
                    else:
                        version.provenance[field] = value
                    with self.assertRaises(ValueError):
                        plugin_package_resources.for_version(version)
            # Correct provenance cannot authorize a differently named source file.
            other = path.with_name("other-method.json")
            other.write_bytes(path.read_bytes())
            with self.assertRaises(ValueError):
                plugin_package_resources.for_version(_builtin_version(other))
            with self.assertRaises(ValueError):
                plugin_package_resources.for_version(_version(str(path)))


class RealZipPackageTests(unittest.TestCase):
    def test_valid_zip_version_parses_resource_bundle(self):
        data, checksum = _valid_zip_bytes()
        with tempfile.NamedTemporaryFile(suffix=".soduwork-plugin", delete=False) as handle:
            handle.write(data)
            path = handle.name
        try:
            version = _version(path, checksum=checksum)
            bundle = plugin_package_resources.for_version(version)
            self.assertEqual(bundle, plugin_packages.parse(data)["resourceBundle"])
            self.assertTrue(bundle["resources"] or bundle["skills"]
                            or bundle["digest"])
        finally:
            os.unlink(path)


    def test_json_named_archive_still_requires_original_checksum(self):
        data, checksum = _valid_zip_bytes()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "uploaded-package.json"
            path.write_bytes(data)
            version = _version(str(path), checksum=checksum)
            self.assertEqual(plugin_package_resources.for_version(version),
                             plugin_packages.parse(data)["resourceBundle"])
            version.checksum = "unexpected-checksum"
            with self.assertRaises(ValueError):
                plugin_package_resources.for_version(version)


class CorruptPackageTests(unittest.TestCase):
    def _corrupt_zip(self, suffix):
        handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        handle.write(b"definitely not a zip archive")
        handle.close()
        return handle.name

    def test_corrupt_zip_with_bundled_skills_raises(self):
        path = self._corrupt_zip(".soduwork-plugin")
        try:
            version = _version(path, capability_report={
                "bundledSkills": [{"name": "s", "archivePath": "a/SKILL.md"}]})
            with self.assertRaises(ValueError):
                plugin_package_resources.for_version(version)
        finally:
            os.unlink(path)

    def test_corrupt_zip_without_requirements_raises(self):
        # Fail closed for corrupt ZIP packages even when no resources are requested.
        path = self._corrupt_zip(".soduwork-plugin")
        try:
            version = _version(path)
            with self.assertRaises(ValueError):
                plugin_package_resources.for_version(version)
        finally:
            os.unlink(path)


class LegacyNoPackageBehaviourTests(unittest.TestCase):
    def test_empty_path_without_bundled_skills_returns_empty_bundle(self):
        version = _version("")
        self.assertEqual(
            plugin_package_resources.for_version(version),
            {"resources": [], "skills": [], "digest": _empty_digest()})

    def test_empty_path_with_bundled_skills_raises(self):
        version = _version("", capability_report={
            "bundledSkills": [{"name": "s", "archivePath": "a/SKILL.md"}]})
        with self.assertRaises(ValueError):
            plugin_package_resources.for_version(version)

    def test_missing_file_raises(self):
        version = _version("Z:/不存在/missing.soduwork-plugin")
        with self.assertRaises(ValueError):
            plugin_package_resources.for_version(version)


if __name__ == "__main__":
    unittest.main()
