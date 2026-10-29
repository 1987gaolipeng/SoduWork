"""Enforce folder names per owner, storage backend and parent, including root."""
from alembic import op
import sqlalchemy as sa


revision = "0051_library_folder_integrity"
down_revision = "0050_library_folder_favorite"
branch_labels = None
depends_on = None


def _repair_storage_tree(connection, folders):
    """0049 marked direct MinIO folders but omitted their empty ancestors."""
    rows = {r["id"]: dict(r) for r in connection.execute(sa.select(folders)).mappings()}
    items = sa.table("library_item", sa.column("id", sa.String), sa.column("owner_key", sa.String),
                     sa.column("backend", sa.String), sa.column("folder_id", sa.String))
    item_rows = connection.execute(sa.select(items)).mappings().all()
    local_ancestors = set()
    for item in item_rows:
        folder = rows.get(item["folder_id"])
        visited = set()
        while item["backend"] == "local" and folder and folder["id"] not in visited:
            if folder["owner_key"] != item["owner_key"]:
                break
            visited.add(folder["id"])
            local_ancestors.add(folder["id"])
            folder = rows.get(folder["parent_id"])
    for row in rows.values():
        if row["backend"] != "minio":
            continue
        parent, visited = rows.get(row["parent_id"]), {row["id"]}
        while parent and parent["id"] not in visited and parent["id"] not in local_ancestors:
            if parent["owner_key"] != row["owner_key"]:
                break
            visited.add(parent["id"])
            parent["backend"] = "minio"
            connection.execute(folders.update().where(folders.c.id == parent["id"]).values(backend="minio"))
            parent = rows.get(parent["parent_id"])
    # Mixed legacy trees cannot exist in two tabs. Keep every object, placing
    # only incompatible links at their own storage root instead of hiding them.
    for row in rows.values():
        parent = rows.get(row["parent_id"])
        if row["parent_id"] and (not parent or (parent["owner_key"], parent["backend"]) != (row["owner_key"], row["backend"])):
            connection.execute(folders.update().where(folders.c.id == row["id"]).values(parent_id=None))
    for item in item_rows:
        folder = rows.get(item["folder_id"])
        if item["folder_id"] and (not folder or (folder["owner_key"], folder["backend"]) != (item["owner_key"], item["backend"])):
            connection.execute(items.update().where(items.c.id == item["id"]).values(folder_id=None))


def upgrade():
    connection = op.get_bind()
    folders = sa.table("library_folder", sa.column("id", sa.String),
                       sa.column("owner_key", sa.String), sa.column("backend", sa.String),
                       sa.column("parent_id", sa.String), sa.column("name", sa.String))
    _repair_storage_tree(connection, folders)
    rows = connection.execute(sa.select(folders).order_by(folders.c.id)).mappings().all()
    # Older NULL-root constraints allowed concurrent duplicate names. Retain
    # every folder and its children, giving only duplicates a stable suffix.
    occupied = {(r["owner_key"], r["backend"], r["parent_id"] or "", r["name"]) for r in rows}
    seen = set()
    for row in rows:
        scope = (row["owner_key"], row["backend"], row["parent_id"] or "")
        key = (*scope, row["name"])
        if key in seen:
            number = 2
            name = row["name"]
            while (*scope, name) in occupied:
                suffix = f" ({number})"
                name = row["name"][:160 - len(suffix)] + suffix
                number += 1
            connection.execute(folders.update().where(folders.c.id == row["id"]).values(name=name))
            occupied.add((*scope, name))
        seen.add(key)
    with op.batch_alter_table("library_folder") as batch:
        batch.drop_constraint("uq_library_folder_owner_parent_name", type_="unique")
    op.create_index("uq_library_folder_scope_name", "library_folder",
                    ["owner_key", "backend", sa.text("coalesce(parent_id, '')"), "name"], unique=True)


def downgrade():
    op.drop_index("uq_library_folder_scope_name", table_name="library_folder")
    with op.batch_alter_table("library_folder") as batch:
        batch.create_unique_constraint("uq_library_folder_owner_parent_name", ["owner_key", "parent_id", "name"])
