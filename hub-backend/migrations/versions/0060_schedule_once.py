"""Add absolute one-time appointments without changing existing periodic plans."""
from alembic import op
import sqlalchemy as sa

revision = "0060_schedule_once"
down_revision = "0059_identity_key_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_schedule", sa.Column("run_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ai_schedule", sa.Column("once_fired", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM ai_schedule WHERE every = 'once'")):
        raise RuntimeError("Convert or remove one-time schedules explicitly before dropping their timing fields")
    with op.batch_alter_table("ai_schedule") as batch:
        batch.drop_column("once_fired")
        batch.drop_column("run_at")
