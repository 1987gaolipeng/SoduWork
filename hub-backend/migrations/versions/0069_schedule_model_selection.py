"""Persist the model selected for each automation schedule.

Revision ID: 0069_schedule_model_selection
Revises: 0068_merge_notification_account
"""
from alembic import op
import sqlalchemy as sa

revision = "0069_schedule_model_selection"
down_revision = "0068_merge_notification_account"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.add_column("ai_schedule", sa.Column("model_name", sa.String(length=300), nullable=False, server_default=""))

def downgrade() -> None:
    op.drop_column("ai_schedule", "model_name")
