"""Ordered remote selection without connecting to an external service."""

import unittest
from unittest.mock import patch

from app.config import Settings
from app.services import library_storage as storage


class RemoteSelectionTests(unittest.TestCase):
    def settings(self, **overrides):
        values = dict(
            library_storage_backend="local", library_remote_order="minio,nfs",
            minio_endpoint="", minio_access_key="", minio_secret_key="",
            library_minio_endpoint="", library_minio_access_key="",
            library_minio_secret_key="", library_nfs_host="", library_nfs_export="",
        )
        values.update(overrides)
        settings = Settings(_env_file=None, **values)
        self.addCleanup(patch.stopall)
        patch("app.services.library_storage.get_settings", return_value=settings).start()
        patch("app.services.library_nfs.get_settings", return_value=settings).start()
        return settings

    def minio(self):
        return dict(library_minio_endpoint="http://minio.invalid:9000",
                    library_minio_access_key="access", library_minio_secret_key="secret",
                    library_minio_bucket="library")

    def nfs(self):
        return dict(library_nfs_host="nfs.invalid", library_nfs_export="/exports/library")

    def test_remote_alias_selects_complete_minio_without_connecting(self):
        self.settings(**self.minio())
        with patch.object(storage, "ensure_ready") as probe:
            self.assertEqual(storage.resolve_backend("remote"), "minio")
            probe.assert_not_called()

    def test_nfs_only_and_partial_minio_use_network_nfs(self):
        self.settings(library_minio_endpoint="minio.invalid", **self.nfs())
        self.assertEqual(storage.resolve_backend("remote"), "nfs")

    def test_order_is_respected_and_deduplicated(self):
        self.settings(library_remote_order=" NFS, minio, nfs ", **self.nfs(), **self.minio())
        self.assertEqual(storage.remote_order(), ["nfs", "minio"])
        self.assertEqual(storage.resolve_backend("remote"), "nfs")
        self.assertEqual(storage.resolve_backend("minio"), "minio")
        self.assertEqual(storage.resolve_backend("local"), "local")

    def test_remote_requires_a_complete_configuration_and_order_rejects_typos(self):
        self.settings()
        with self.assertRaises(storage.LibraryStorageError):
            storage.resolve_backend("remote")
        self.settings(library_remote_order="nfz,minio", **self.minio())
        with self.assertRaises(storage.LibraryStorageError) as caught:
            storage.remote_order()
        self.assertFalse(caught.exception.retryable)

    def test_auto_is_local_only_when_no_remote_configuration_was_supplied(self):
        self.settings(library_storage_backend="auto")
        self.assertEqual(storage.storage_backend(), "local")
        self.settings(library_storage_backend="auto", library_nfs_host="nfs.invalid")
        with self.assertRaises(storage.LibraryStorageError):
            storage.storage_backend()
        self.settings(library_storage_backend="auto", **self.nfs())
        self.assertEqual(storage.storage_backend(), "nfs")

    def test_unavailable_first_provider_never_probes_or_activates_standby(self):
        self.settings(library_storage_backend="remote", **self.minio(), **self.nfs())
        def ready(backend):
            if backend == "minio":
                raise storage.LibraryStorageError()
            return True
        with patch.object(storage, "ensure_ready", side_effect=ready) as probe:
            result = storage.status()
        self.assertEqual([call.args[0] for call in probe.call_args_list], ["local", "minio"])
        self.assertEqual(result["remoteBackend"], "minio")
        self.assertEqual(result["default"], "minio")
        self.assertEqual(result["storage"]["remote"]["state"], "unavailable")
        self.assertEqual(result["storage"]["nfs"]["state"], "standby")
        self.assertTrue(result["storage"]["nfs"]["configured"])
        self.assertNotIn("secret", str(result))
        self.assertNotIn("nfs.invalid", str(result))

    def test_status_keeps_legacy_aliases_and_reports_active_nfs(self):
        self.settings(**self.nfs())
        with patch.object(storage, "ensure_ready", return_value=True):
            result = storage.status()
        self.assertEqual(result["remoteBackend"], "nfs")
        self.assertEqual(result["remote"]["backend"], "nfs")
        self.assertTrue(result["remote"]["available"])
        self.assertEqual(result["remoteOrder"], ["minio", "nfs"])
        for backend in ("local", "minio", "nfs", "remote"):
            self.assertEqual(result[backend], result["storage"][backend])

    def test_malformed_minio_endpoint_does_not_block_valid_nfs_or_break_status(self):
        for endpoint in ("http://[broken", "minio.invalid:wrong", "minio.invalid:99999", "minio.invalid:"):
            with self.subTest(endpoint=endpoint):
                self.settings(library_storage_backend="remote", **(self.minio() | {
                    "library_minio_endpoint": endpoint}), **self.nfs())
                self.assertEqual(storage.resolve_backend("remote"), "nfs")
                with patch.object(storage, "ensure_ready", return_value=True):
                    self.assertEqual(storage.status()["default"], "nfs")

    def test_status_preserves_actionable_safe_provider_errors(self):
        self.settings(**self.nfs())
        error = storage.LibraryStorageError("LIBRARY_NFS_ACCESS_DENIED", "NFS 导出目录缺少资料读写权限，请检查 UID/GID", False)
        with patch.object(storage, "ensure_ready", side_effect=lambda backend: True if backend == "local" else (_ for _ in ()).throw(error)):
            result = storage.status()
        self.assertEqual(result["remote"]["message"], error.message)

    def test_unsupported_nfs_version_is_explained_without_local_fallback(self):
        self.settings(library_storage_backend="auto", library_nfs_version=4, **self.nfs())
        with self.assertRaises(storage.LibraryStorageError) as caught:
            storage.storage_backend()
        self.assertEqual(caught.exception.code, "LIBRARY_NFS_UNSUPPORTED_VERSION")
        with patch.object(storage, "ensure_ready", return_value=True):
            result = storage.status()
        self.assertEqual(result["remote"]["code"], "LIBRARY_NFS_UNSUPPORTED_VERSION")
        self.assertIn("NFSv3", result["remote"]["message"])
        self.assertFalse(result["remote"]["available"])


if __name__ == "__main__":
    unittest.main()
