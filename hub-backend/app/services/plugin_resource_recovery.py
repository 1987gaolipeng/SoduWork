"""Preserve modified resource copies before restoring immutable package bytes."""
from __future__ import annotations

import base64
import errno
import hashlib
import os
import shutil
import stat
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path


def file_hash(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


@contextmanager
def preparation_lock(root, directory, no_links):
    """Serialize this fingerprint across Runner processes, with a bounded wait."""
    lock = directory / '.materialize.lock'
    no_links(root, lock)
    if lock.exists() and not stat.S_ISREG(lock.lstat().st_mode):
        raise ValueError('插件资源准备锁不是普通文件')
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    descriptor = os.open(lock, flags, 0o600)
    acquired = False
    try:
        no_links(root, lock)
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError('插件资源准备锁不是普通文件')
        if os.name == 'nt':
            import msvcrt
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b'\0')
            def change_lock(unlock=False):
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK if unlock else msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            def change_lock(unlock=False):
                fcntl.flock(descriptor, fcntl.LOCK_UN if unlock else fcntl.LOCK_EX | fcntl.LOCK_NB)
        deadline = time.monotonic() + 2
        while not acquired:
            try:
                change_lock()
                acquired = True
            except OSError as error:
                if error.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise
                if time.monotonic() >= deadline:
                    raise ValueError('插件资源正在由另一个进程准备，请稍后重试') from error
                time.sleep(0.025)
        no_links(root, lock)
        opened, current = os.fstat(descriptor), lock.stat()
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError('插件资源准备锁已变化，请稍后重试')
        yield
    finally:
        try:
            if acquired:
                change_lock(unlock=True)
        finally:
            # Closing the native handle releases the lock even if unlock fails.
            os.close(descriptor)


def _snapshot(root, source, no_links):
    """Include empty folders and every byte; reject links and special objects."""
    rows = []
    def visit(file):
        no_links(root, file)
        mode = file.lstat().st_mode
        relative = file.relative_to(source).as_posix()
        if stat.S_ISREG(mode):
            rows.append((relative, 'file', file_hash(file)))
        elif stat.S_ISDIR(mode):
            rows.append((relative, 'directory', ''))
            for child in sorted(file.iterdir()):
                visit(child)
        else:
            raise ValueError('插件资源修改副本含有特殊文件，无法安全备份')
    visit(source)
    return rows


def _copy(root, source, backup, no_links):
    no_links(root, source)
    no_links(root, backup)
    if source.is_dir():
        backup.mkdir()
        for child in source.iterdir():
            _copy(root, child, backup / child.name, no_links)
    else:
        # Exclusive creation never overwrites a previous backup.
        with source.open('rb') as incoming, backup.open('xb') as outgoing:
            shutil.copyfileobj(incoming, outgoing)


def rescue(root, directory, file, label, no_links):
    """Return a unique backup path; a failed copy always leaves its source."""
    backup = None
    try:
        no_links(root, file)
        before = _snapshot(root, file, no_links)
        saved_root = Path(tempfile.mkdtemp(prefix='.local-', dir=directory))
        backup = saved_root.joinpath(*label.split('/'))
        no_links(root, backup)
        backup.parent.mkdir(parents=True, exist_ok=True)
        no_links(root, backup)
        try:
            os.rename(file, backup)
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            _copy(root, file, backup, no_links)
            if (_snapshot(root, backup, no_links) != before
                    or _snapshot(root, file, no_links) != before):
                raise ValueError('本机修改在备份期间发生变化')
            # The absolute source remains inside the verified active work root.
            no_links(root, file)
            if file.is_dir():
                shutil.rmtree(file)
            else:
                file.unlink()
    except FileNotFoundError:
        # An external materializer can finish before this process sees it.
        # A disappeared backup after a copy must never be treated as success.
        if not file.exists() and backup is None:
            return None
        raise ValueError('插件资源 ' + label + ' 的备份状态已变化，请稍后重试')
    except (OSError, ValueError) as error:
        raise ValueError('插件资源 ' + label + ' 被本机修改且暂时无法备份，请关闭占用它的程序后重试：'
                         + str(backup or file)) from error
    return {'path': label, 'backup': backup.relative_to(directory).as_posix()}


def restore(items, root, directory, no_links):
    rescued, backups = [], []
    directory.mkdir(parents=True, exist_ok=True)
    with preparation_lock(root, directory, no_links):
        for item in items:
            file = directory.joinpath(*item['path'].split('/'))
            # A bounded retry also handles changes made outside the Runner lock.
            for attempt in range(3):
                no_links(root, file)
                if file.exists():
                    if file.is_file() and file_hash(file) == item['sha256']:
                        break
                    saved = rescue(root, directory, file, item['path'], no_links)
                    if saved:
                        if item['path'] not in rescued:
                            rescued.append(item['path'])
                        backups.append(saved)
                file.parent.mkdir(parents=True, exist_ok=True)
                no_links(root, file)
                try:
                    flags = os.O_CREAT | os.O_WRONLY | os.O_EXCL | getattr(os, 'O_BINARY', 0)
                    with os.fdopen(os.open(file, flags, 0o600), 'wb') as output:
                        output.write(base64.b64decode(item['content']))
                    break
                except FileExistsError:
                    if attempt == 2:
                        raise ValueError('插件资源写入冲突，请稍后重试：' + item['path'])
        # Check the full set before exposing the bundle as a trusted read scope.
        for item in items:
            file = directory.joinpath(*item['path'].split('/'))
            no_links(root, file)
            if not file.is_file() or file_hash(file) != item['sha256']:
                raise ValueError('插件资源写入冲突，请稍后重试：' + item['path'])
    return rescued, backups
