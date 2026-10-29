"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0006_team_daily_reports"
down_revision: Union[str, Sequence[str], None] = "0005_device_security"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "team_daily_report",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("org_name", sa.String(length=64), nullable=False),
        sa.Column("date", sa.String(length=10), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("summary", sa.JSON(), nullable=False),
        sa.Column("metrics", sa.JSON(), nullable=False),
        sa.Column("source_refs", sa.JSON(), nullable=False),
        sa.Column("source_digest", sa.String(length=64), nullable=False),
        sa.Column("confirmed_by", sa.String(length=36), nullable=False),
        sa.Column("confirmed_by_name", sa.String(length=64), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("leader_note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "date", name="uq_team_daily_report_org_date"),
    )
    with op.batch_alter_table("team_daily_report", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_team_daily_report_date"), ["date"], unique=False)
        batch_op.create_index(batch_op.f("ix_team_daily_report_org_id"), ["org_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_team_daily_report_status"), ["status"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("team_daily_report", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_team_daily_report_status"))
        batch_op.drop_index(batch_op.f("ix_team_daily_report_org_id"))
        batch_op.drop_index(batch_op.f("ix_team_daily_report_date"))
    op.drop_table("team_daily_report")
