"""Remove PostgreSQL's redundant identity-provider key constraint.

0004 created both an unnamed UNIQUE constraint and the unique index declared
by the model. PostgreSQL reflects both, so Alembic check reports schema drift.
Keep the independent unique index and all data; SQLite needs no DDL change.
"""
from alembic import op
import sqlalchemy as sa

revision = "0059_identity_key_index"
down_revision = "0058_usage_source_title"
branch_labels = None
depends_on = None

TABLE = "identity_provider"
INDEX = "ix_identity_provider_key"


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    inspector = sa.inspect(bind)
    # Refuse to remove any protection unless the model's independent unique
    # index already exists. Never use CASCADE for referencing foreign keys.
    if not any(index["name"] == INDEX and index.get("unique")
               and index.get("column_names") == ["key"]
               and not index.get("duplicates_constraint")
               for index in inspector.get_indexes(TABLE)):
        raise RuntimeError("Identity provider key unique index is missing")
    for constraint in inspector.get_unique_constraints(TABLE):
        if constraint.get("column_names") == ["key"]:
            op.drop_constraint(constraint["name"], TABLE, type_="unique")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    if not any(constraint.get("column_names") == ["key"]
               for constraint in sa.inspect(bind).get_unique_constraints(TABLE)):
        op.create_unique_constraint("identity_provider_key_key", TABLE, ["key"])
