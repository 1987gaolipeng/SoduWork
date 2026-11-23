"""Preserve historical task text during offline replay and undo-delete."""
from alembic import op
import sqlalchemy as sa

revision = "0092_task_text_storage"
down_revision = "0091_domain_sort_validation"
branch_labels = None
depends_on = None


def migrate_schema(connection):
    """Also used before stamping an unversioned database at the current head."""
    if connection.dialect.name != "postgresql":
        # SQLite already stores arbitrary-length VARCHAR values. Rebuilding its
        # task table would add risk to references without changing that behavior.
        return
    columns = {item["name"]: item for item in sa.inspect(connection).get_columns("task")}
    changes = [f"ALTER COLUMN {name} TYPE TEXT" for name in ("title", "source")
               if not isinstance(columns[name]["type"], sa.Text)]
    if changes:
        connection.execute(sa.text("ALTER TABLE task " + ", ".join(changes)))


def upgrade():
    migrate_schema(op.get_bind())


def downgrade():
    connection = op.get_bind()
    if connection.dialect.name == "postgresql":
        # Hold the same lock as ALTER until commit so concurrent sync cannot
        # insert an oversized snapshot between this check and narrowing columns.
        connection.execute(sa.text("LOCK TABLE task IN ACCESS EXCLUSIVE MODE"))
    if connection.execute(sa.text(
            "SELECT 1 FROM task WHERE length(title) > 200 OR length(source) > 120 LIMIT 1")).first():
        raise RuntimeError(
            "Cannot narrow task text while historical values exceed the old limits; "
            "retain the current schema or restore the matching backup")
    if connection.dialect.name == "postgresql":
        connection.execute(sa.text(
            "ALTER TABLE task ALTER COLUMN title TYPE VARCHAR(200), "
            "ALTER COLUMN source TYPE VARCHAR(120)"))
    # SQLite has no enforced VARCHAR limit to restore, so preserve its table.
