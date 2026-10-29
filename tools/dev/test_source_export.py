"""Source distribution integrity and exclusion checks with synthetic ZIP fixtures."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

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


if __name__ == '__main__':
    unittest.main()
