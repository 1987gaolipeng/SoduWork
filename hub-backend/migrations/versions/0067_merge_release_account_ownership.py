"""Join the current release history with the preserved account-isolation history.

The release line continued from ``0065_merge_recommendation_usage`` through
``0065_merge_usage_notifications`` before the account work was merged. The
latest release revision must be a parent here; pointing at the older merge
would leave that release migration as a second Alembic head.
"""

from alembic import op
import sqlalchemy as sa

revision = "0067_merge_release_account_ownership"
down_revision = ("0065_merge_usage_notifications", "0066_schedule_account_ownership")
branch_labels = None
depends_on = None


def upgrade() -> None:
    context = op.get_context()
    if context.dialect.name == "postgresql":
        # Alembic creates VARCHAR(32) by default, but this permanent merge ID
        # has 36 characters. Its upgrade runs before Alembic writes that ID.
        op.alter_column(context.version_table, "version_num",
                        type_=sa.String(128), existing_type=sa.String(32),
                        existing_nullable=False, schema=context.version_table_schema)


def downgrade() -> None:
    # Alembic still stores the 36-character ID while this function runs.
    # Keep the wider metadata column for safe downgrades and later reupgrades.
    pass
