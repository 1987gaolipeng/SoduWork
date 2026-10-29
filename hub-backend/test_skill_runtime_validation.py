"""Legacy transport/cache boundaries, with temporary files and no services."""
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from app.services import plugin_packages, plugin_skill_cache, runner_skills


GOOD = b'---\nname: debug-radar\ndescription: "Gather evidence: preserve logs"\n---\nKeep instructions.\n'
BAD = GOOD.replace(b'"Gather evidence: preserve logs"', b'Gather evidence: preserve logs')


class RuntimeValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='soduwork-yaml-runtime-')
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(runner_skills._CACHE.clear)
        runner_skills._CACHE.clear()
        for target in ('app.services.runner_skills._data_root', 'app.services.local_base._data_root'):
            mock = patch(target, return_value=self.temp.name)
            mock.start()
            self.addCleanup(mock.stop)

    def runner_bundle(self, content=GOOD):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('manifest.json', json.dumps({'schemaVersion': 1, 'skills': [
                {'name': 'debug-radar', 'dir': '00-debug-radar', 'description': 'Legacy metadata'}]}))
            archive.writestr('skills/00-debug-radar/SKILL.md', content)
        return stream.getvalue()

    def plugin_bundle(self, content=GOOD):
        package = self.root / 'legacy.zip'
        with zipfile.ZipFile(package, 'w') as archive:
            archive.writestr('skills/debug-radar/SKILL.md', content)
            archive.writestr('skills/debug-radar/references/keep.txt', b'keep')
        with zipfile.ZipFile(package) as archive:
            checksum = plugin_packages._canonical_digest(archive, {x.filename: x for x in archive.infolist()})
        report = {'bundledSkills': [{'name': 'debug-radar', 'archivePrefix': 'skills/debug-radar',
                                    'archivePath': 'skills/debug-radar/SKILL.md'}]}
        return package, checksum, report

    def plugin_install(self, package, checksum, report):
        return plugin_skill_cache.materialize_skills(str(package), checksum, report,
            safe_zip=plugin_packages._safe_zip, canonical_digest=plugin_packages._canonical_digest,
            max_files=300, max_unpacked=30 * 1024 * 1024)

    def test_runner_rejects_invalid_or_mismatched_skill_before_ready(self):
        for content in (BAD, GOOD.replace(b'name: debug-radar', b'name: another-skill')):
            with self.subTest(content=content):
                data = self.runner_bundle(content)
                with self.assertRaisesRegex(ValueError, 'SKILL.md'):
                    runner_skills.install(data)
                target = self.root / 'runner-plugin-skills' / hashlib.sha256(data).hexdigest()
                self.assertFalse(target.exists())

    def test_runner_rechecks_legacy_ready_cache_without_rewriting(self):
        data = self.runner_bundle()
        installed = runner_skills.install(data)
        skill = Path(installed[0]['path'], 'SKILL.md')
        self.assertEqual(installed[0]['description'], 'Gather evidence: preserve logs')
        skill.write_bytes(BAD)
        with self.assertRaisesRegex(ValueError, 'SKILL.md'):
            runner_skills.install(data)
        self.assertEqual(skill.read_bytes(), BAD)

    def test_runner_rejects_incorrect_ready_marker_without_rewriting(self):
        data = self.runner_bundle()
        runner_skills.install(data)
        marker = self.root / 'runner-plugin-skills' / hashlib.sha256(data).hexdigest() / '.ready'
        marker.write_text('wrong-checksum')
        with self.assertRaisesRegex(ValueError, '缓存校验'):
            runner_skills.install(data)
        self.assertEqual(marker.read_text(), 'wrong-checksum')

    def test_runner_rejects_portable_path_collisions_before_publish(self):
        for entry in ('skills/00-debug-radar/skill.md', 'skills/00-debug-radar/SKILL.md'):
            with self.subTest(entry=entry):
                stream = io.BytesIO(self.runner_bundle())
                with zipfile.ZipFile(stream, 'a') as archive:
                    archive.writestr(entry, BAD)
                data = stream.getvalue()
                with self.assertRaisesRegex(ValueError, '重复|冲突'):
                    runner_skills.install(data)
                target = self.root / 'runner-plugin-skills' / hashlib.sha256(data).hexdigest()
                self.assertFalse(target.exists())

    def test_runner_build_checks_source_even_after_memory_cache_hit(self):
        skill = self.root / 'source' / 'SKILL.md'
        skill.parent.mkdir()
        skill.write_bytes(GOOD)
        items = [{'name': 'debug-radar', 'path': str(skill.parent), 'bundled': True, 'packageChecksum': 'a' * 64}]
        self.assertTrue(runner_skills.build(items))
        skill.write_bytes(BAD)
        with self.assertRaisesRegex(ValueError, 'SKILL.md'):
            runner_skills.build(items)

    def test_plugin_rejects_bad_legacy_package_before_ready(self):
        package, checksum, report = self.plugin_bundle(BAD)
        with self.assertRaisesRegex(ValueError, 'SKILL.md'):
            self.plugin_install(package, checksum, report)
        self.assertFalse((self.root / 'plugin-skills' / checksum).exists())

    def test_plugin_rechecks_legacy_ready_cache_without_rewriting(self):
        package, checksum, report = self.plugin_bundle()
        installed = self.plugin_install(package, checksum, report)
        skill = Path(installed[0]['path'], 'SKILL.md')
        self.assertEqual(installed[0]['description'], 'Gather evidence: preserve logs')
        skill.write_bytes(BAD)
        with self.assertRaisesRegex(ValueError, 'SKILL.md'):
            self.plugin_install(package, checksum, report)
        self.assertEqual(skill.read_bytes(), BAD)
