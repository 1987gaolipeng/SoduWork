"""Exercise every library migration on a private, disposable SQLite database."""
import importlib
import unittest

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


REVISIONS = (
    "0047_library", "0048_library_trash", "0049_library_storage_backend",
    "0050_library_folder_favorite", "0051_library_folder_integrity",
)


class LibraryMigrationTests(unittest.TestCase):
    def test_upgrade_repairs_minio_ancestors_and_keeps_mixed_storage_objects_visible(self):
        engine = sa.create_engine("sqlite:///:memory:")
        modules = [importlib.import_module("migrations.versions." + revision) for revision in REVISIONS]
        try:
            with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
                modules[0].upgrade()
                for folder_id, parent in (("root", None), ("leaf", "root"), ("mixed", None)):
                    connection.execute(sa.text(
                        "INSERT INTO library_folder (id, owner_key, name, parent_id) "
                        "VALUES (:id, 'alice', :id, :parent)"
                    ), {"id": folder_id, "parent": parent})
                for item_id, folder, backend in (("remote", "leaf", "minio"),
                                                  ("mixed-local", "mixed", "local"),
                                                  ("mixed-remote", "mixed", "minio")):
                    connection.execute(sa.text(
                        "INSERT INTO library_item (id, owner_key, folder_id, backend) "
                        "VALUES (:id, 'alice', :folder, :backend)"
                    ), {"id": item_id, "folder": folder, "backend": backend})
                for module in modules[1:]:
                    module.upgrade()
                self.assertEqual(connection.execute(sa.text(
                    "SELECT backend FROM library_folder WHERE id='root'"
                )).scalar_one(), "minio")
                self.assertEqual(connection.execute(sa.text(
                    "SELECT parent_id FROM library_folder WHERE id='leaf'"
                )).scalar_one(), "root")
                items = connection.execute(sa.text("SELECT id, folder_id FROM library_item ORDER BY id")).all()
                self.assertEqual(items, [("mixed-local", None), ("mixed-remote", "mixed"), ("remote", "leaf")])
        finally:
            engine.dispose()

    def test_upgrade_existing_folders_preserves_items_and_round_trips_schema(self):
        engine = sa.create_engine("sqlite:///:memory:")
        modules = [importlib.import_module("migrations.versions." + revision) for revision in REVISIONS]
        try:
            with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
                modules[0].upgrade()
                for folder_id in ("first", "second"):
                    connection.execute(sa.text(
                        "INSERT INTO library_folder (id, owner_key, name) VALUES (:id, 'alice', 'docs')"
                    ), {"id": folder_id})
                connection.execute(sa.text(
                    "INSERT INTO library_item (id, owner_key, folder_id, backend) "
                    "VALUES ('retained-item', 'alice', 'second', 'local')"
                ))
                for module in modules[1:]:
                    module.upgrade()
                folders = connection.execute(sa.text("SELECT id, name FROM library_folder ORDER BY id")).all()
                self.assertEqual(folders, [("first", "docs"), ("second", "docs (2)")])
                self.assertEqual(connection.execute(sa.text(
                    "SELECT folder_id FROM library_item WHERE id='retained-item'"
                )).scalar_one(), "second")
                with self.assertRaises(sa.exc.IntegrityError):
                    connection.execute(sa.text(
                        "INSERT INTO library_folder (id, owner_key, name) VALUES ('third', 'alice', 'docs')"
                    ))
                connection.execute(sa.text(
                    "INSERT INTO library_folder (id, owner_key, name, backend) "
                    "VALUES ('remote', 'alice', 'docs', 'minio')"
                ))
                for module in reversed(modules):
                    module.downgrade()
                self.assertEqual(sa.inspect(connection).get_table_names(), [])
        finally:
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
