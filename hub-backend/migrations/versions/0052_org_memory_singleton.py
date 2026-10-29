"""Keep one current organization summary without discarding legacy content.

Each exact organization/department ID remains independent. Existing archived
rows stay archived, and retiring a duplicate preserves its ID, key, content and
timestamps so it can be inspected and recovered deliberately.
"""
from alembic import op
import sqlalchemy as sa


revision = "0052_org_memory_singleton"
down_revision = "0051_library_folder_integrity"
branch_labels = None
depends_on = None


def consolidate_and_enforce(connection) -> None:
    """Also used once when adopting an unversioned database at the head."""
    inspector = sa.inspect(connection)
    if not inspector.has_table("memory_record"):
        return
    if any(index["name"] == "uq_memory_record_org_current"
           for index in inspector.get_indexes("memory_record")):
        return
    if connection.dialect.name == "postgresql":
        # Hold writers out between choosing the current row and enforcing the
        # invariant; the migration transaction releases this lock at commit.
        connection.execute(sa.text("LOCK TABLE memory_record IN SHARE ROW EXCLUSIVE MODE"))
    records = sa.table(
        "memory_record", sa.column("id", sa.String), sa.column("org_id", sa.String),
        sa.column("scope", sa.String), sa.column("owner_user_id", sa.String),
        sa.column("memory_key", sa.String), sa.column("archived", sa.Boolean),
        sa.column("revision", sa.Integer), sa.column("updated_at", sa.DateTime),
    )
    ranked = sa.select(records.c.id, sa.func.row_number().over(
        partition_by=records.c.org_id,
        order_by=((records.c.memory_key == "default").desc(),
                  records.c.updated_at.desc(), records.c.id),
    ).label("position")).where(
        records.c.scope == "org", records.c.owner_user_id == "",
        records.c.archived.is_(False),
    ).subquery()
    connection.execute(records.update().where(records.c.id.in_(
        sa.select(ranked.c.id).where(ranked.c.position > 1),
    )).values(archived=True, revision=records.c.revision + 1))
    connection.execute(sa.text(
        "CREATE UNIQUE INDEX uq_memory_record_org_current ON memory_record (org_id) "
        "WHERE scope = 'org' AND owner_user_id = '' AND archived = false"
    ))


def upgrade() -> None:
    consolidate_and_enforce(op.get_bind())


def downgrade() -> None:
    op.drop_index("uq_memory_record_org_current", table_name="memory_record")
    # Never resurrect retired summaries automatically during a downgrade.
