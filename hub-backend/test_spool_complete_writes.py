"""Raw pipe/file short writes must not truncate an Agent turn."""
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.services import local_spool_worker as worker


class ShortWriter:
    def __init__(self, limit=7):
        self.limit, self.data, self.closed, self.flushes = limit, bytearray(), False, 0

    def write(self, data):
        if self.limit is None or self.limit == 0:
            return self.limit
        part = data[:self.limit]
        self.data.extend(part)
        return len(part)

    def flush(self):
        self.flushes += 1

    def close(self):
        self.closed = True


class SpoolCompleteWriteTests(unittest.TestCase):
    def test_stdout_and_stdin_keep_every_byte_across_short_writes(self):
        chunks = ['中文🙂'.encode() * 90, bytes(range(256)) * 4]
        for mode in ('copy', 'feed'):
            with self.subTest(mode=mode):
                destination, done = ShortWriter(), threading.Event()
                source = SimpleNamespace(fileno=lambda: 41)
                with patch.object(worker.os, 'read', side_effect=[*chunks, b'']):
                    if mode == 'copy':
                        worker._copy(source, destination, done)
                    else:
                        worker._feed(source, destination)
                self.assertEqual(destination.data, b''.join(chunks))
                self.assertEqual(destination.flushes, len(chunks))
                self.assertEqual(destination.closed, mode == 'feed')
                self.assertEqual(done.is_set(), mode == 'copy')

    def test_no_progress_stops_before_consuming_another_chunk(self):
        for mode in ('copy', 'feed'):
            for count in (None, 0):
                with self.subTest(mode=mode, count=count):
                    destination, done = ShortWriter(count), threading.Event()
                    source = SimpleNamespace(fileno=lambda: 41)
                    with patch.object(worker.os, 'read', side_effect=[b'first', b'second', b'']) as read:
                        if mode == 'copy':
                            worker._copy(source, destination, done)
                        else:
                            worker._feed(source, destination)
                    self.assertEqual(read.call_count, 1)
                    self.assertEqual(destination.flushes, 0)
                    self.assertEqual(destination.closed, mode == 'feed')
                    self.assertEqual(done.is_set(), mode == 'copy')


if __name__ == '__main__':
    unittest.main()
