"""Track the declared origin and reversible archive state of managed records."""
from alembic import op
import sqlalchemy as sa

revision = "0095_business_record_source"
down_revision = "0094_review_recipient"
branch_labels = None
depends_on = None

TABLES = ("project", "repo", "org_unit", "position")


def upgrade():
    for table in TABLES:
        op.add_column(table, sa.Column("data_source", sa.String(12), nullable=False, server_default="legacy"))
        op.add_column(table, sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("UPDATE position SET data_source = 'business' WHERE is_system IS TRUE")


def downgrade():
    for table in reversed(TABLES):
        op.drop_column(table, "is_archived")
        op.drop_column(table, "data_source")
