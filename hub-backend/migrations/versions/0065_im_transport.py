"""Merge current branches and add durable, opt-in IM transport state."""
from alembic import op
import sqlalchemy as sa

revision = "0065_im_transport"
down_revision = ("0064_usage_attribution", "0063_plugin_recommendation")
branch_labels = None
depends_on = None


def _s(name, size, **kw):
    return sa.Column(name, sa.String(size), nullable=False, **kw)


def _time(name, nullable=False):
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade():
    op.create_table("im_connection", _s("id", 36, primary_key=True),
        _s("owner_user_id", 36), _s("owner_client_id", 64),
        sa.Column("user_version", sa.Integer(), nullable=False),
        sa.Column("client_version", sa.Integer(), nullable=False),
        _s("provider", 24), _s("name", 100), sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("credentials", sa.Text(), nullable=False), sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
    op.create_index("ix_im_connection_owner_user_id", "im_connection", ["owner_user_id"])
    op.create_table("im_pairing", _s("code_hash", 64, primary_key=True), _s("connection_id", 36),
        _s("task_id", 36), _s("runner_id", 80), sa.Column("options", sa.JSON(), nullable=False),
        _time("expires_at"), _time("used_at", True))
    op.create_index("ix_im_pairing_connection_id", "im_pairing", ["connection_id"])
    op.create_table("im_webhook_receipt", _s("connection_id", 36, primary_key=True),
        _s("verification_key", 64, primary_key=True), _s("content_hash", 64), _time("created_at"))
    op.create_index("ix_im_webhook_receipt_expiry", "im_webhook_receipt", ["connection_id", "created_at"])
    op.create_table("im_binding", _s("id", 36, primary_key=True), _s("connection_id", 36),
        _s("identity_key", 64), sa.Column("external_identity", sa.JSON(), nullable=False),
        _s("task_id", 36), _s("runner_id", 80), sa.Column("options", sa.JSON(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("connection_id", "identity_key", name="uq_im_binding_identity"))
    op.create_index("ix_im_binding_connection_id", "im_binding", ["connection_id"])
    op.create_index("ix_im_binding_task_id", "im_binding", ["task_id"])
    op.create_table("im_route", _s("task_id", 36, primary_key=True), _s("active_inbox_id", 36),
        _s("lease_token", 36), _time("lease_until", True))
    op.create_table("im_inbox", _s("id", 36, primary_key=True), _s("connection_id", 36),
        _s("event_id", 180), _s("content_hash", 64), _s("binding_id", 36), _s("task_id", 36),
        sa.Column("text", sa.Text(), nullable=False), sa.Column("reply_context", sa.JSON(), nullable=False),
        _s("status", 24), _s("ref", 180), _s("admission_key", 160), _time("accepted_at", True), _time("diagnosed_at", True),
        sa.Column("base_seq", sa.Integer(), nullable=False), sa.Column("base_round", sa.Integer(), nullable=False),
        _s("detail", 160), _time("available_at"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("connection_id", "event_id", name="uq_im_inbox_event"))
    op.create_index("ix_im_inbox_due", "im_inbox", ["status", "available_at"])
    op.create_index("ix_im_inbox_task_order", "im_inbox", ["task_id", "created_at", "id"])
    op.create_table("im_outbox", _s("id", 36, primary_key=True), _s("inbox_id", 36),
        _s("connection_id", 36), _s("binding_id", 36), _s("kind", 24),
        sa.Column("part", sa.Integer(), nullable=False), sa.Column("text", sa.Text(), nullable=False),
        _s("status", 24), sa.Column("attempts", sa.Integer(), nullable=False),
        _s("external_message_id", 180), _s("detail", 160), _time("available_at"),
        _s("lease_token", 36), _time("lease_until", True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("inbox_id", "kind", "part", name="uq_im_outbox_part"))
    op.create_index("ix_im_outbox_due", "im_outbox", ["status", "available_at"])
    op.create_index("ix_im_outbox_binding_order", "im_outbox", ["binding_id", "status", "created_at", "part", "id"])


def downgrade():
    for table in ("im_outbox", "im_inbox", "im_route", "im_binding", "im_webhook_receipt", "im_pairing", "im_connection"):
        op.drop_table(table)
