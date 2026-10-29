"""Quality command paths remain inside the verified checkout on each platform."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

os.environ.setdefault('DATABASE_URL', 'sqlite+aiosqlite:///:memory:')
from app.services.runner_quality import _command_dir


class QualityCommandPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='soduwork-quality-paths-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'backend').mkdir()

    def test_forward_slash_checkout_supports_a_real_subproject(self):
        self.assertEqual(_command_dir(self.root.as_posix(), 'backend'),
                         os.path.realpath(self.root / 'backend'))

    def test_trailing_separator_and_dot_use_the_same_canonical_root(self):
        self.assertEqual(_command_dir(self.root.as_posix() + '/', '.'),
                         os.path.realpath(self.root))
        self.assertEqual(_command_dir(self.root.as_posix() + '/', ''),
                         os.path.realpath(self.root))

    def test_absolute_paths_are_rejected_even_if_the_child_exists(self):
        for value in ('/backend', str(self.root / 'backend')):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '不合法'):
                _command_dir(str(self.root), value)

    def test_traversal_and_missing_subprojects_are_rejected(self):
        with self.assertRaisesRegex(ValueError, '不合法'):
            _command_dir(str(self.root), '../outside')
        with self.assertRaisesRegex(ValueError, '不存在'):
            _command_dir(str(self.root), 'missing')

    def test_linked_subproject_cannot_escape_or_change_outside_files(self):
        with tempfile.TemporaryDirectory(prefix='soduwork-quality-outside-') as directory:
            outside = Path(directory)
            marker = outside / 'keep.txt'
            marker.write_text('unchanged', encoding='utf-8')
            link = self.root / 'linked'
            if os.name == 'nt':
                result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)],
                                        capture_output=True, creationflags=0x08000000)
                self.assertEqual(result.returncode, 0, 'isolated junction fixture must exist')
            else:
                link.symlink_to(outside, target_is_directory=True)
            try:
                with self.assertRaisesRegex(ValueError, '越过'):
                    _command_dir(self.root.as_posix(), 'linked')
                self.assertEqual(marker.read_text(encoding='utf-8'), 'unchanged')
            finally:
                if os.name == 'nt':
                    link.rmdir()
                else:
                    link.unlink()


if __name__ == '__main__':
    unittest.main()
