"""Separate device-reported chat references from authoritative source IDs."""
from alembic import op
import sqlalchemy as sa

revision = "0096_usage_chat_source"
down_revision = "0095_business_record_source"
branch_labels = None
depends_on = None


def backfill(connection):
    # Older key-only receipts populated source_id without a conversation_id.
    # Neither those keys nor contradictory references establish a session.
    connection.execute(sa.text("""
        UPDATE ai_usage_event
        SET reported_chat_session_id = CASE WHEN source_id = conversation_id THEN source_id ELSE '' END
        WHERE reported_chat_session_id IS NULL AND source_type = 'chat'
          AND (idempotency_key LIKE 'client:%' OR idempotency_key LIKE 'client-account:%')
    """))


def upgrade():
    op.add_column("ai_usage_event", sa.Column("reported_chat_session_id", sa.String(180)))
    backfill(op.get_bind())


def downgrade():
    op.execute("""
        UPDATE ai_usage_event SET source_id = reported_chat_session_id,
                                  conversation_id = reported_chat_session_id
        WHERE reported_chat_session_id IS NOT NULL AND source_id = '' AND conversation_id = ''
    """)
    op.drop_column("ai_usage_event", "reported_chat_session_id")
