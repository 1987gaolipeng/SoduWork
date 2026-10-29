"""Direct NFS adapter exercised over real local TCP/XDR, without OS mounts."""
import io
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import library_nfs
from app.services.library_storage import LibraryStorageError
from tests.nfs_wire_fixture import Peer

KEY = "library/users/" + "a" * 64 + "/item/object"


class LibraryNfsTests(unittest.TestCase):
    def setUp(self):
        self.peer = Peer()
        self.settings = SimpleNamespace(library_nfs_host="127.0.0.1", library_nfs_port=self.peer.port,
            library_nfs_export="/资料", library_nfs_mount_port=self.peer.port, library_nfs_version=3,
            library_nfs_uid=1234, library_nfs_gid=2345, library_nfs_timeout=1)
        self.settings_patch = patch.object(library_nfs, "get_settings", return_value=self.settings)
        self.settings_patch.start()

    def tearDown(self):
        self.settings_patch.stop()
        self.peer.stop()

    def put(self, content=b"Hello NFS"):
        return library_nfs.put_stream(KEY, io.BytesIO(content), len(content), "text/plain")

    def test_real_wire_upload_read_delete_and_auth_identity(self):
        self.assertTrue(library_nfs.ensure_ready())
        self.assertEqual(self.put(), "nfs")
        stream = library_nfs.open_stream(KEY)
        try:
            self.assertEqual(stream.read(5), b"Hello")
            self.assertEqual(stream.read(99), b" NFS")
            self.assertEqual(stream.read(5), b"")
        finally:
            stream.close()
        self.assertEqual(self.peer.export, "/资料")
        self.assertEqual(set(self.peer.auth), {(1234, 2345)})
        self.assertIn((100003, 21), self.peer.calls)
        self.assertIn((100003, 14), self.peer.calls)
        library_nfs.delete(KEY)
        library_nfs.delete(KEY)
        with self.assertRaises(FileNotFoundError):
            library_nfs.open_stream(KEY)

    def test_short_writes_and_fragmented_rpc_records_preserve_all_bytes(self):
        self.peer.short_write = 3
        self.peer.short_read = 4
        self.peer.fragment = True
        self.put(b"0123456789abcdef")
        with library_nfs.open_stream(KEY) as stream:
            self.assertEqual(stream.read(), b"0123456789abcdef")

    def test_empty_file_is_committed_and_readable(self):
        self.put(b"")
        with library_nfs.open_stream(KEY) as stream:
            self.assertEqual(stream.read(), b"")

    def test_truncated_upload_does_not_replace_previous_object_or_leave_temporary_file(self):
        self.put(b"original")
        with self.assertRaises(LibraryStorageError):
            library_nfs.put_stream(KEY, io.BytesIO(b"short"), 10, "text/plain")
        with library_nfs.open_stream(KEY) as stream:
            self.assertEqual(stream.read(), b"original")
        self.assertEqual(set(self.peer.resolve(KEY.rsplit("/", 1)[0])["children"]), {"object"})

    def test_write_and_commit_failures_never_publish_partial_objects(self):
        for name in ("fail_write", "bad_commit"):
            setattr(self.peer, name, True)
            with self.subTest(name=name), self.assertRaises(LibraryStorageError):
                self.put(b"incomplete")
            self.assertEqual(self.peer.resolve(KEY.rsplit("/", 1)[0])["children"], {})
            setattr(self.peer, name, False)

    def test_symlinks_and_foreign_namespaces_never_become_read_or_write_targets(self):
        self.peer.child(b"root", "library", 5)
        with self.assertRaises(LibraryStorageError):
            self.put()
        for key in ("../escape", "/absolute", "library/users/../escape", "other/file", KEY + "/../file", KEY + "\\file"):
            with self.subTest(key=key), self.assertRaises(LibraryStorageError):
                library_nfs.open_stream(key)

    def test_early_eof_is_not_returned_as_a_successful_truncated_download(self):
        self.put()
        with library_nfs.open_stream(KEY) as stream:
            self.peer.read_early_eof = True
            with self.assertRaises(LibraryStorageError):
                stream.read(100)

    def test_bad_rpc_xid_oversize_eof_and_timeout_fail_promptly(self):
        self.put()
        for fault in ("xid", "oversized", "fragments", "eof", "timeout"):
            self.settings.library_nfs_timeout = .05
            with library_nfs.open_stream(KEY) as stream:
                self.peer.reply_fault = fault
                started = time.monotonic()
                with self.subTest(fault=fault), self.assertRaises(LibraryStorageError):
                    stream.read(1)
                self.assertLess(time.monotonic() - started, 1)
                self.peer.reply_fault = ""

    def test_configuration_rejects_unsupported_versions_and_incomplete_remote_addresses(self):
        for field, value in (("library_nfs_host", ""), ("library_nfs_host", "nfs://example.com"),
                             ("library_nfs_export", "D:/mounted"), ("library_nfs_export", "/a/../b"),
                             ("library_nfs_port", 0), ("library_nfs_version", 4), ("library_nfs_uid", -1)):
            old = getattr(self.settings, field)
            setattr(self.settings, field, value)
            with self.subTest(field=field, value=value), self.assertRaises(LibraryStorageError):
                library_nfs.configuration()
            setattr(self.settings, field, old)

    def test_portmapper_discovers_remote_mountd_when_port_is_not_configured(self):
        from app.services import library_nfs_rpc
        self.settings.library_nfs_mount_port = 0
        with patch.object(library_nfs_rpc, "PORTMAPPER_PORT", self.peer.port):
            self.put(b"discovered mountd")
            with library_nfs.open_stream(KEY) as stream:
                self.assertEqual(stream.read(), b"discovered mountd")
        self.assertIn((100000, 3), self.peer.calls)

    def test_large_binary_round_trip_is_not_converted_to_text(self):
        content = bytes(range(256)) * 1024
        self.put(content)
        with library_nfs.open_stream(KEY) as stream:
            self.assertEqual(stream.read(len(content) + 1), content)

    def test_health_probe_is_read_only_and_requires_access_permissions(self):
        self.assertTrue(library_nfs.ensure_ready())
        self.assertFalse(any(program == 100003 and procedure in (7, 8, 9, 12, 14) for program, procedure in self.peer.calls))
        self.peer.access_mask = 1
        with self.assertRaises(LibraryStorageError) as denied:
            library_nfs.ensure_ready()
        self.assertEqual(denied.exception.code, "LIBRARY_NFS_ACCESS_DENIED")

    def test_final_file_symlinks_are_not_read_or_deleted(self):
        self.put()
        self.peer.resolve(KEY)["type"] = 5
        with self.assertRaises(LibraryStorageError):
            library_nfs.open_stream(KEY)
        with self.assertRaises(LibraryStorageError):
            library_nfs.delete(KEY)
        self.assertEqual(self.peer.resolve(KEY)["type"], 5)

    def test_upload_with_extra_bytes_is_not_silently_truncated(self):
        with self.assertRaises(LibraryStorageError):
            library_nfs.put_stream(KEY, io.BytesIO(b"too long"), 3, "text/plain")
        self.assertEqual(self.peer.resolve(KEY.rsplit("/", 1)[0])["children"], {})

    def test_connections_close_after_success_read_failure_and_mount_rejection(self):
        self.put()
        with library_nfs.open_stream(KEY) as stream:
            stream.read()
        self.peer.mount_status = 13
        with self.assertRaises(LibraryStorageError):
            library_nfs.ensure_ready()
        deadline = time.monotonic() + 1
        while self.peer.connections and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertEqual(self.peer.connections, 0)

    def test_remote_host_validation_accepts_addresses_and_dns_but_not_malformed_ports_or_brackets(self):
        for host, expected in (("127.0.0.1", "127.0.0.1"), ("nfs.internal", "nfs.internal"),
                               ("localhost", "localhost"), ("[::1]", "::1"),
                               ("2001:db8::1234", "2001:db8::1234")):
            self.settings.library_nfs_host = host
            self.assertEqual(library_nfs.configuration()["host"], expected)
        for host in ("host:abc", "host:2049", "[broken", "::1]", "[[::1]]", "[127.0.0.1]",
                     "[::1]:2049", "2001:db8::not-ip", "999.0.0.1", "-invalid.internal", "nfs..internal"):
            self.settings.library_nfs_host = host
            with self.subTest(host=host):
                with self.assertRaises(LibraryStorageError) as invalid:
                    library_nfs.configuration()
                self.assertEqual(invalid.exception.code, "LIBRARY_NFS_NOT_CONFIGURED")
                self.assertFalse(invalid.exception.retryable)

    def test_mountd_statuses_distinguish_permissions_export_configuration_and_server_failure(self):
        for status, code, retryable in ((1, "ACCESS_DENIED", False), (13, "ACCESS_DENIED", False),
                                       (2, "EXPORT_NOT_FOUND", False), (20, "NOT_CONFIGURED", False),
                                       (22, "NOT_CONFIGURED", False), (63, "NOT_CONFIGURED", False),
                                       (10004, "PROTOCOL_UNSUPPORTED", False),
                                       (5, "UNAVAILABLE", True), (10006, "UNAVAILABLE", True)):
            self.peer.mount_status = status
            with self.subTest(status=status):
                with self.assertRaises(LibraryStorageError) as rejected:
                    library_nfs.ensure_ready()
                self.assertEqual(rejected.exception.code, "LIBRARY_NFS_" + code)
                self.assertEqual(rejected.exception.retryable, retryable)

    def test_unsupported_mount_auth_flavors_do_not_trigger_file_operations(self):
        for flavors in ([6], [0], []):
            self.peer.mount_auth_flavors = flavors
            with self.subTest(flavors=flavors):
                with self.assertRaises(LibraryStorageError) as unsupported:
                    library_nfs.ensure_ready()
                self.assertEqual(unsupported.exception.code, "LIBRARY_NFS_AUTH_UNSUPPORTED")
                self.assertFalse(unsupported.exception.retryable)
        self.assertFalse(any(program == 100003 for program, _ in self.peer.calls))
        self.peer.mount_auth_flavors = [6, 1]
        self.assertTrue(library_nfs.ensure_ready())
