"""Add generation modality and per-model media invocation config."""

from alembic import op
import sqlalchemy as sa


revision = "0038_multimedia_models"
down_revision = "0037_hot_path_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "model_def",
        sa.Column("modality", sa.String(length=16), nullable=False, server_default="chat"),
    )
    op.add_column(
        "model_def",
        sa.Column("config", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("model_def", "config")
    op.drop_column("model_def", "modality")
