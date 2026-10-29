"""Isolated Runner repairs preserve local edits without trusting changed versions."""
import errno
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from app.services import plugin_resources as resources


PATH = 'references/口径与限制.md'
ORIGINAL = '日报口径：按确认后的统计规则执行。\n'
RAW = [dict(path=PATH, kind='reference', encoding='utf8', content=ORIGINAL)]
KEY = 'mcp-trend'


class PluginResourceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.initial = resources.materialize(RAW, self.root, KEY)
        self.directory = Path(self.initial['directory'])
        self.file = self.directory / PATH

    def repair(self):
        return resources.materialize(RAW, self.root, KEY)

    def backup(self, bundle):
        return self.directory / bundle['backups'][0]['backup']

    def test_modified_reference_is_backed_up_and_restored_from_trusted_bytes(self):
        self.file.write_text('用户调整的日报统计规则', encoding='utf8')
        bundle = self.repair()
        self.assertEqual(self.file.read_text(encoding='utf8'), ORIGINAL)
        self.assertEqual(bundle['rescued'], [PATH])
        self.assertEqual(self.backup(bundle).read_text(encoding='utf8'), '用户调整的日报统计规则')
        self.assertEqual(bundle['directory'], self.initial['directory'])
        self.assertEqual(bundle['digest'], self.initial['digest'])

    def test_repeated_edits_keep_each_backup_and_unchanged_calls_make_none(self):
        self.file.write_bytes(b'first edit')
        first = self.repair()
        self.file.write_bytes(b'second edit')
        second = self.repair()
        self.assertNotEqual(self.backup(first), self.backup(second))
        self.assertEqual(self.backup(first).read_bytes(), b'first edit')
        self.assertEqual(self.backup(second).read_bytes(), b'second edit')
        third = self.repair()
        self.assertEqual(third['rescued'], [])
        self.assertEqual(third['backups'], [])
        self.assertEqual(len(list(self.directory.glob('.local-*'))), 2)

    def test_backup_names_do_not_overwrite_existing_hidden_directory_or_local_resource(self):
        existing = self.directory / '.local-existing' / PATH
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b'older saved work')
        rows = [*RAW, dict(path='references/' + 'note.local', kind='reference',
                          encoding='utf8', content='declared resource')]
        other = resources.materialize(rows, self.root, KEY)
        other_root = Path(other['directory'])
        (other_root / PATH).write_bytes(b'new work')
        recovered = resources.materialize(rows, self.root, KEY)
        self.assertEqual((other_root / 'references/note.local').read_text(), 'declared resource')
        self.assertEqual((other_root / recovered['backups'][0]['backup']).read_bytes(), b'new work')
        self.file.write_bytes(b'another edit')
        self.repair()
        self.assertEqual(existing.read_bytes(), b'older saved work')

    def test_a_directory_in_place_of_a_resource_is_preserved_as_a_directory(self):
        self.file.unlink()
        self.file.mkdir()
        (self.file / 'notes.txt').write_text('my notes', encoding='utf8')
        (self.file / 'empty').mkdir()
        recovered = self.repair()
        self.assertEqual(self.file.read_text(encoding='utf8'), ORIGINAL)
        self.assertEqual((self.backup(recovered) / 'notes.txt').read_text(), 'my notes')
        self.assertTrue((self.backup(recovered) / 'empty').is_dir())

    def test_manifest_checksum_failure_never_repairs_or_moves_existing_cache(self):
        self.file.write_bytes(b'keep this edit')
        bad = [{**RAW[0], 'sha256': '0' * 64}]
        with self.assertRaisesRegex(ValueError, '校验不一致'):
            resources.materialize(bad, self.root, KEY)
        self.assertEqual(self.file.read_bytes(), b'keep this edit')
        self.assertEqual(list(self.directory.glob('.local-*')), [])

    def test_leftover_lock_file_is_reused_and_does_not_block_recovery(self):
        (self.directory / '.materialize.lock').write_bytes(b'stale file after a stopped Runner')
        self.file.write_bytes(b'work after restart')
        bundle = self.repair()
        self.assertEqual(self.backup(bundle).read_bytes(), b'work after restart')
        self.assertEqual(self.file.read_text(encoding='utf8'), ORIGINAL)

    def test_invalid_lock_directory_keeps_user_edit_and_reports_safe_failure(self):
        lock = self.directory / '.materialize.lock'
        lock.unlink()
        lock.mkdir()
        self.file.write_bytes(b'work untouched by invalid lock')
        with self.assertRaisesRegex(ValueError, '锁不是普通文件'):
            self.repair()
        self.assertEqual(self.file.read_bytes(), b'work untouched by invalid lock')

    def test_symlink_resource_is_rejected_without_touching_its_target(self):
        target = self.root / 'business-notes.txt'
        target.write_bytes(b'private business notes')
        self.file.unlink()
        try:
            self.file.symlink_to(target)
        except OSError as error:
            self.skipTest('symbolic links unavailable: ' + str(error))
        with self.assertRaisesRegex(ValueError, '链接|联接'):
            self.repair()
        self.assertEqual(target.read_bytes(), b'private business notes')
        self.assertTrue(self.file.is_symlink())

    @unittest.skipUnless(os.name == 'nt', 'Windows junction regression')
    def test_junction_resource_directory_is_rejected_without_touching_target(self):
        target = self.root / 'external-cache'
        target.mkdir()
        (target / '口径与限制.md').write_bytes(b'keep junction target')
        self.file.unlink()
        self.file.parent.rmdir()
        result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(self.file.parent), str(target)],
                                capture_output=True, text=True)
        if result.returncode:
            self.skipTest('junction unavailable')
        self.addCleanup(lambda: os.rmdir(self.file.parent) if self.file.parent.exists() else None)
        with self.assertRaisesRegex(ValueError, '链接|联接'):
            self.repair()
        self.assertEqual((target / '口径与限制.md').read_bytes(), b'keep junction target')

    def test_failed_backup_keeps_source_and_does_not_restore_over_user_bytes(self):
        self.file.write_bytes(b'keep source')
        with patch('os.rename', side_effect=PermissionError(errno.EACCES, 'busy')):
            with self.assertRaisesRegex(ValueError, '无法备份'):
                self.repair()
        self.assertEqual(self.file.read_bytes(), b'keep source')

    def test_cross_device_copy_is_verified_before_removing_source(self):
        self.file.write_bytes(b'cross-device edit')
        with patch('os.rename', side_effect=OSError(errno.EXDEV, 'cross-device')):
            bundle = self.repair()
        self.assertEqual(self.backup(bundle).read_bytes(), b'cross-device edit')
        self.assertEqual(self.file.read_text(encoding='utf8'), ORIGINAL)

    def test_corrupted_cross_device_copy_preserves_source(self):
        self.file.write_bytes(b'original local work')
        def corrupt(_source, destination, *args, **kwargs):
            destination.write(b'incomplete copy')
        with patch('os.rename', side_effect=OSError(errno.EXDEV, 'cross-device')):
            with patch('shutil.copyfileobj', side_effect=corrupt):
                with self.assertRaisesRegex(ValueError, '无法备份'):
                    self.repair()
        self.assertEqual(self.file.read_bytes(), b'original local work')

    def test_edits_during_cross_device_copy_preserve_the_current_source(self):
        self.file.write_bytes(b'first local work')
        copy = shutil.copyfileobj
        def changed(source, destination, *args, **kwargs):
            copy(source, destination, *args, **kwargs)
            self.file.write_bytes(b'new edit during copy')
        with patch('os.rename', side_effect=OSError(errno.EXDEV, 'cross-device')):
            with patch('shutil.copyfileobj', side_effect=changed):
                with self.assertRaisesRegex(ValueError, '无法备份'):
                    self.repair()
        self.assertEqual(self.file.read_bytes(), b'new edit during copy')

    def test_cross_device_directory_copy_preserves_all_entries(self):
        self.file.unlink()
        self.file.mkdir()
        (self.file / 'notes.txt').write_bytes(b'work in folder')
        (self.file / 'empty').mkdir()
        with patch('os.rename', side_effect=OSError(errno.EXDEV, 'cross-device')):
            bundle = self.repair()
        self.assertEqual((self.backup(bundle) / 'notes.txt').read_bytes(), b'work in folder')
        self.assertTrue((self.backup(bundle) / 'empty').is_dir())
        self.assertEqual(self.file.read_text(encoding='utf8'), ORIGINAL)

    def test_simultaneous_materializers_keep_user_edit_once_and_all_return_valid_bundle(self):
        self.file.write_bytes(b'one shared local edit')
        with ThreadPoolExecutor(max_workers=4) as executor:
            bundles = list(executor.map(lambda _: self.repair(), range(8)))
        backups = [self.directory / row['backup'] for bundle in bundles for row in bundle['backups']]
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b'one shared local edit')
        self.assertEqual(self.file.read_text(encoding='utf8'), ORIGINAL)

    def test_simultaneous_runner_processes_recover_once_without_partial_resource_reads(self):
        self.file.write_bytes(b'shared edit across Runner processes')
        start = self.root / 'begin'
        code = ('import json,sys,time; from pathlib import Path; '
                'from app.services import plugin_resources as r; '
                'root=Path(sys.argv[1]); ready=Path(sys.argv[2]); ready.touch(); '
                'start=root/"begin"; deadline=time.monotonic()+8\n'
                'while not start.exists():\n'
                ' if time.monotonic()>deadline: raise TimeoutError("fixture barrier")\n'
                ' time.sleep(.01)\n'
                'print(json.dumps(r.materialize(json.loads(sys.argv[3]),root,sys.argv[4])))')
        children = []
        for index in range(3):
            ready = self.root / ('ready-' + str(index))
            process = subprocess.Popen([sys.executable, '-c', code, str(self.root), str(ready),
                                        json.dumps(RAW), KEY], cwd=Path(__file__).parent,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(lambda child=process: child.kill() if child.poll() is None else None)
            children.append((process, ready))
        deadline = time.monotonic() + 6
        while not all(ready.exists() for _, ready in children) and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(all(ready.exists() for _, ready in children))
        start.touch()
        bundles = []
        for child, _ in children:
            output, errors = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, errors)
            bundles.append(json.loads(output))
        backups = [row for bundle in bundles for row in bundle['backups']]
        self.assertEqual(len(backups), 1)
        self.assertEqual((self.directory / backups[0]['backup']).read_bytes(), b'shared edit across Runner processes')
        self.assertEqual(self.file.read_text(encoding='utf8'), ORIGINAL)

    def test_active_preparation_lock_times_out_without_reclaiming_or_overwriting_source(self):
        from app.services.plugin_resource_recovery import preparation_lock
        self.file.write_bytes(b'keep active Runner edit')
        with preparation_lock(self.root, self.directory, resources._no_links):
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, '另一个进程准备'):
                self.repair()
            self.assertLess(time.monotonic() - started, 4)
            self.assertEqual(self.file.read_bytes(), b'keep active Runner edit')
            self.assertEqual(list(self.directory.glob('.local-*')), [])
        bundle = self.repair()
        self.assertEqual(self.backup(bundle).read_bytes(), b'keep active Runner edit')

    @unittest.skipUnless(os.name == 'nt', 'Windows lock cleanup regression')
    def test_unlock_error_still_closes_descriptor_and_does_not_poison_later_repairs(self):
        import msvcrt
        from app.services.plugin_resource_recovery import preparation_lock
        lock = msvcrt.locking
        def failed_unlock(descriptor, mode, count):
            if mode == msvcrt.LK_UNLCK:
                raise OSError(errno.EIO, 'failed explicit unlock')
            return lock(descriptor, mode, count)
        with patch('msvcrt.locking', side_effect=failed_unlock):
            with self.assertRaises(OSError):
                with preparation_lock(self.root, self.directory, resources._no_links):
                    self.file.write_bytes(b'edit survives unlock failure')
        bundle = self.repair()
        self.assertEqual(self.backup(bundle).read_bytes(), b'edit survives unlock failure')

    def test_guidance_reports_each_backup_as_quoted_paths(self):
        self.file.write_bytes(b'local draft')
        bundle = self.repair()
        note = resources.guidance(bundle)
        self.assertIn('原始资源已恢复', note)
        self.assertIn(json.dumps(PATH, ensure_ascii=False), note)
        self.assertIn(json.dumps(bundle['backups'][0]['backup'], ensure_ascii=False), note)


if __name__ == '__main__':
    unittest.main()
