"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003_preflight_evidence"
down_revision: Union[str, Sequence[str], None] = "0002_automation_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "automation_preflight_evidence",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("subject_kind", sa.String(length=32), nullable=False),
        sa.Column("subject_id", sa.String(length=64), nullable=False),
        sa.Column("check_kind", sa.String(length=40), nullable=False),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("summary", sa.String(length=600), nullable=False),
        sa.Column("executor_id", sa.String(length=80), nullable=False),
        sa.Column("executor_name", sa.String(length=100), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True),
                  server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("subject_kind", "subject_id", "check_kind",
                            name="uq_preflight_evidence_subject_check"),
    )
    with op.batch_alter_table("automation_preflight_evidence", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_automation_preflight_evidence_check_kind"),
                              ["check_kind"], unique=False)
        batch_op.create_index(batch_op.f("ix_automation_preflight_evidence_fingerprint"),
                              ["fingerprint"], unique=False)
        batch_op.create_index(batch_op.f("ix_automation_preflight_evidence_state"),
                              ["state"], unique=False)
        batch_op.create_index(batch_op.f("ix_automation_preflight_evidence_subject_id"),
                              ["subject_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_automation_preflight_evidence_subject_kind"),
                              ["subject_kind"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("automation_preflight_evidence", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_automation_preflight_evidence_subject_kind"))
        batch_op.drop_index(batch_op.f("ix_automation_preflight_evidence_subject_id"))
        batch_op.drop_index(batch_op.f("ix_automation_preflight_evidence_state"))
        batch_op.drop_index(batch_op.f("ix_automation_preflight_evidence_fingerprint"))
        batch_op.drop_index(batch_op.f("ix_automation_preflight_evidence_check_kind"))
    op.drop_table("automation_preflight_evidence")
