"""Verified email accounts, consent, mail delivery and privacy operations.

Existing usernames and organization assignments are retained. An email-shaped
username is deliberately not backfilled as a verified email address.
"""
from alembic import op
import sqlalchemy as sa

revision = "0063_email_accounts"
down_revision = "0062_plugin_recommendation_cover"
branch_labels = None
depends_on = None


def stamp(name):
    return sa.Column(name, sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())


def upgrade():
    with op.batch_alter_table("app_user") as batch:
        batch.add_column(sa.Column("email", sa.String(254), nullable=True))
        batch.add_column(sa.Column("email_normalized", sa.String(254), nullable=True))
        batch.add_column(sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("avatar_url", sa.Text(), nullable=False, server_default=""))
        batch.add_column(sa.Column("account_deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_unique_constraint("uq_app_user_email_normalized", ["email_normalized"])

    op.create_table("account_email_challenge",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email_normalized", sa.String(254), nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=True),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True), stamp("created_at"))
    op.create_index("ix_account_email_challenge_expiry", "account_email_challenge", ["expires_at"])
    op.create_table("account_email_rate_limit",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_account_email_rate_limit_expires_at", "account_email_rate_limit", ["expires_at"])
    op.create_table("account_user_consent",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("document", sa.String(32), nullable=False),
        sa.Column("version", sa.String(64), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False, server_default=""), stamp("accepted_at"),
        sa.UniqueConstraint("user_id", "document", "version", name="uq_account_consent_version"))
    op.create_index("ix_account_user_consent_user_id", "account_user_consent", ["user_id"])

    op.create_table("account_mail_outbox",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("challenge_id", sa.String(36), nullable=True, unique=True),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("recipient_mask", sa.String(254), nullable=False),
        sa.Column("payload_encrypted", sa.Text(), nullable=False, server_default=""),
        sa.Column("state", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"), stamp("next_attempt_at"),
        sa.Column("lease_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(64), nullable=False, server_default=""), stamp("created_at"))
    op.create_index("ix_account_mail_outbox_due", "account_mail_outbox", ["state", "next_attempt_at"])
    op.create_index("ix_account_mail_outbox_created", "account_mail_outbox", ["created_at"])

    op.create_table("account_action_grant",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("user_auth_version", sa.Integer(), nullable=False),
        sa.Column("client_auth_version", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True), stamp("created_at"))
    for field in ("user_id", "client_id", "expires_at"):
        op.create_index("ix_account_action_grant_" + field, "account_action_grant", [field])
    op.create_table("account_privacy_request",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claim_token", sa.String(64), nullable=False, server_default=""),
        sa.Column("error_code", sa.String(64), nullable=False, server_default=""),
        sa.Column("result_encrypted", sa.Text(), nullable=False, server_default=""),
        sa.Column("evidence", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True), stamp("created_at"), stamp("updated_at"))
    for field in ("user_id", "status", "expires_at"):
        op.create_index("ix_account_privacy_request_" + field, "account_privacy_request", [field])


def downgrade():
    for table in ("account_privacy_request", "account_action_grant", "account_mail_outbox",
                  "account_user_consent", "account_email_rate_limit", "account_email_challenge"):
        op.drop_table(table)
    with op.batch_alter_table("app_user") as batch:
        batch.drop_constraint("uq_app_user_email_normalized", type_="unique")
        for column in ("account_deleted_at", "avatar_url", "email_verified_at", "email_normalized", "email"):
            batch.drop_column(column)
