"""Source distribution integrity and exclusion checks with synthetic ZIP fixtures."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import subprocess
from unittest.mock import patch

from tools import export_source


class SourceExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='source-export-test-')
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / 'source.zip'
        self.profile = {'schema': 1, 'id': 'opensource-v1', 'sourceOnly': True,
                        'excludedPrefixes': ['docs/design/'], 'excludedFiles': ['private.env'],
                        'skills': ['office'], 'buildChecks': []}

    def bundle(self, additions=None, changes=None):
        data = {'README.md': b'Public source\n', 'LICENSE': b'Copyright MDiRi\n',
                'tools/distribution/PUBLIC-SOURCE.json': json.dumps(self.profile).encode()}
        data.update(additions or {})
        manifest = {'schema': 1, 'ok': True, 'distribution': 'public-source', 'files': [
            {'path': name, 'bytes': len(export_source.canonical(body)),
             'sha256': hashlib.sha256(export_source.canonical(body)).hexdigest()}
            for name, body in data.items()]}
        data.update(changes or {})
        data['tools/distribution/SOURCE-MANIFEST.json'] = json.dumps(manifest).encode()
        with zipfile.ZipFile(self.archive, 'w') as out:
            for name, body in data.items():
                out.writestr(name, body)

    def test_archive_is_complete_and_line_endings_are_portable(self):
        self.bundle(changes={'README.md': b'Public source\r\n'})
        self.assertEqual(export_source.verify(self.archive), 4)

    def test_changed_source_and_unlisted_private_files_are_rejected(self):
        self.bundle(changes={'README.md': b'Different source\n'})
        with self.assertRaisesRegex(ValueError, 'integrity mismatch'):
            export_source.verify(self.archive)
        self.bundle()
        with zipfile.ZipFile(self.archive, 'a') as out:
            out.writestr('unlisted.env', b'synthetic-private-setting')
        with self.assertRaisesRegex(ValueError, 'inventory'):
            export_source.verify(self.archive)

    def test_excluded_material_is_rejected_even_with_a_matching_inventory(self):
        for name in ['docs/design/private.md', 'private.env', 'skills/unknown/SKILL.md', 'ops/cluster.json']:
            with self.subTest(name=name):
                self.bundle(additions={name: b'synthetic fixture'})
                with self.assertRaisesRegex(ValueError, 'Excluded'):
                    export_source.verify(self.archive)

    def test_history_traversal_and_symlinks_are_rejected(self):
        for name in ['.git/config', '../escape', '/absolute']:
            with self.subTest(name=name):
                self.bundle(additions={name: b'fixture'})
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    export_source.verify(self.archive)
        self.bundle()
        with zipfile.ZipFile(self.archive, 'a') as out:
            link = zipfile.ZipInfo('link')
            link.external_attr = 0o120777 << 16
            out.writestr(link, '../outside')
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            export_source.verify(self.archive)

    def test_binary_content_is_not_normalized(self):
        self.bundle(additions={'fixture.bin': b'\0\r\n\xff'}, changes={'fixture.bin': b'\0\n\xff'})
        with self.assertRaisesRegex(ValueError, 'integrity mismatch'):
            export_source.verify(self.archive)

    def test_private_content_is_rejected_even_after_renaming_and_manifest_regeneration(self):
        policy = json.loads((export_source.ROOT / 'tools/distribution/PUBLIC-SOURCE.json').read_text(encoding='utf-8'))
        self.profile['excludedIdentifiers'] = policy['excludedIdentifiers']
        self.bundle()
        self.assertEqual(export_source.verify(self.archive), 4)
        for identifier in policy['excludedIdentifiers']:
            with self.subTest(identifier=identifier):
                self.bundle(additions={'client/renamed.cjs': identifier.upper().encode('utf-8')})
                with self.assertRaisesRegex(ValueError, 'Excluded business identifier'):
                    export_source.verify(self.archive)
        self.bundle(additions={'assets/fixture.bin': b'\0' + policy['excludedIdentifiers'][0].encode('utf-8')})
        with self.assertRaisesRegex(ValueError, 'Excluded business identifier'):
            export_source.verify(self.archive)

    def test_private_paths_and_invalid_identifier_policy_are_rejected(self):
        self.profile['excludedIdentifiers'] = ['closed-example']
        self.bundle(additions={'fixtures/CLOSED-EXAMPLE.txt': b'neutral'})
        with self.assertRaisesRegex(ValueError, 'Excluded business identifier'):
            export_source.verify(self.archive)
        self.profile['excludedIdentifiers'] = ['']
        self.bundle()
        with self.assertRaisesRegex(ValueError, 'Invalid excluded identifiers'):
            export_source.verify(self.archive)


class CommittedSourceExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='committed-source-export-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        self.output = self.root.parent / 'source.zip'
        self.git('init')
        self.git('config', 'user.name', 'Source Export Test')
        self.git('config', 'user.email', 'source-export@example.invalid')
        self.profile = self.root / 'tools/distribution/PUBLIC-SOURCE.json'
        self.profile.parent.mkdir(parents=True)
        self.profile.write_text(json.dumps({'schema': 1, 'id': 'opensource-v1', 'sourceOnly': True,
            'excludedPrefixes': ['private/'], 'excludedFiles': [], 'skills': [], 'buildChecks': []}))
        (self.root / 'README.md').write_bytes(b'Committed source\n')
        (self.root / 'fixture.bin').write_bytes(b'\0\r\n\xff')
        for name in ['source-files.cjs', 'check-source-manifest.cjs']:
            (self.root / 'tools' / name).write_bytes((export_source.ROOT / 'tools' / name).read_bytes())
        self.git('add', '.')
        self.git('commit', '-m', 'Create source export fixture')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, text=True, stderr=subprocess.PIPE).strip()

    def export(self):
        with patch.object(export_source, 'ROOT', self.root):
            return export_source.export(self.output)

    def test_export_generates_inventory_from_committed_bytes_and_supports_standalone_checks(self):
        (self.root / 'README.md').write_bytes(b'Uncommitted modification\n')
        (self.root / 'staged.txt').write_bytes(b'Not committed\n')
        self.git('add', 'README.md', 'staged.txt')
        (self.root / 'private.env').write_bytes(b'Local-only fixture\n')
        self.assertEqual(self.export(), 6)
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(archive.read('README.md'), b'Committed source\n')
            self.assertEqual(archive.read('fixture.bin'), b'\0\r\n\xff')
            self.assertNotIn('staged.txt', archive.namelist())
            self.assertNotIn('private.env', archive.namelist())
            manifest = json.loads(archive.read(export_source.MANIFEST))
            self.assertEqual(manifest['commit'], self.git('rev-parse', 'HEAD'))
            extracted = self.root.parent / 'extracted'
            archive.extractall(extracted)
        self.assertFalse((self.root / export_source.MANIFEST).exists())
        result = subprocess.check_output(['node', 'tools/check-source-manifest.cjs'], cwd=extracted, text=True)
        self.assertEqual(json.loads(result)['inventory'], 'archive')
        (extracted / 'README.md').write_text('Tampered source')
        result = subprocess.run(['node', 'tools/check-source-manifest.cjs'], cwd=extracted, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'does not match', result.stderr)

    def test_export_is_repeatable_and_existing_output_is_preserved(self):
        self.export()
        original = self.output.read_bytes()
        with self.assertRaises(FileExistsError):
            self.export()
        self.assertEqual(self.output.read_bytes(), original)
        self.output = self.root.parent / 'second.zip'
        self.export()
        self.assertEqual(self.output.read_bytes(), original)

    def test_committed_private_files_fail_even_with_automatically_generated_inventory(self):
        (self.root / 'private').mkdir()
        (self.root / 'private/fixture.txt').write_text('Excluded fixture')
        self.git('add', '.')
        self.git('commit', '-m', 'Add excluded fixture')
        with self.assertRaisesRegex(ValueError, 'Excluded'):
            self.export()
        self.assertFalse(self.output.exists())

    def test_export_cannot_silently_omit_committed_files(self):
        (self.root / '.gitattributes').write_text('README.md export-ignore\n')
        self.git('add', '.')
        self.git('commit', '-m', 'Add incomplete archive fixture')
        with self.assertRaisesRegex(ValueError, 'committed tree'):
            self.export()
        self.assertFalse(self.output.exists())

    def test_committed_symlinks_are_rejected_and_failed_output_is_removed(self):
        # git update-index makes a real symlink tree entry without requiring
        # Windows developer-mode privileges on the fixture host.
        blob = subprocess.check_output(['git', 'hash-object', '-w', '--stdin'], cwd=self.root,
                                       input=b'../outside').decode().strip()
        self.git('update-index', '--add', '--cacheinfo', f'120000,{blob},link')
        self.git('commit', '-m', 'Add symlink fixture')
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            self.export()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
