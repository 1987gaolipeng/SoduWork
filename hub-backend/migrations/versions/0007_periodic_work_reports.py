"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0007_periodic_work_reports"
down_revision: Union[str, Sequence[str], None] = "0006_team_daily_reports"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("daily_report", schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            "period_type", sa.String(length=16), nullable=False,
            server_default=sa.text("'daily'")))
        batch_op.add_column(sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP")))
        batch_op.create_index(
            batch_op.f("ix_daily_report_period_type"), ["period_type"], unique=False)
        batch_op.create_unique_constraint(
            "uq_personal_report_period", ["user_id", "period_type", "date"])

    with op.batch_alter_table("team_daily_report", schema=None) as batch_op:
        batch_op.drop_constraint("uq_team_daily_report_org_date", type_="unique")
        batch_op.add_column(sa.Column(
            "period_type", sa.String(length=16), nullable=False,
            server_default=sa.text("'daily'")))
        batch_op.create_index(
            batch_op.f("ix_team_daily_report_period_type"), ["period_type"], unique=False)
        batch_op.create_unique_constraint(
            "uq_team_report_period", ["org_id", "period_type", "date"])


def downgrade() -> None:
    with op.batch_alter_table("team_daily_report", schema=None) as batch_op:
        batch_op.drop_constraint("uq_team_report_period", type_="unique")
        batch_op.drop_index(batch_op.f("ix_team_daily_report_period_type"))
        batch_op.drop_column("period_type")
        batch_op.create_unique_constraint(
            "uq_team_daily_report_org_date", ["org_id", "date"])

    with op.batch_alter_table("daily_report", schema=None) as batch_op:
        batch_op.drop_constraint("uq_personal_report_period", type_="unique")
        batch_op.drop_index(batch_op.f("ix_daily_report_period_type"))
        batch_op.drop_column("updated_at")
        batch_op.drop_column("period_type")
