"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0004_identity_foundation"
down_revision: Union[str, Sequence[str], None] = "0003_preflight_evidence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "identity_provider",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("key", sa.String(length=48), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("protocol", sa.String(length=16), nullable=False),
        sa.Column("issuer", sa.String(length=500), nullable=False),
        sa.Column("client_id", sa.String(length=300), nullable=False),
        sa.Column("client_secret_env", sa.String(length=120), nullable=False),
        sa.Column("redirect_uri", sa.String(length=700), nullable=False),
        sa.Column("scopes", sa.JSON(), nullable=False),
        sa.Column("claim_mapping", sa.JSON(), nullable=False),
        sa.Column("allowed_domains", sa.JSON(), nullable=False),
        sa.Column("jit_enabled", sa.Boolean(), nullable=False),
        sa.Column("default_org_id", sa.String(length=36), nullable=True),
        sa.Column("default_role_id", sa.String(length=36), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("probe_state", sa.String(length=16), nullable=False),
        sa.Column("probe_message", sa.String(length=500), nullable=False),
        sa.Column("discovery", sa.JSON(), nullable=False),
        sa.Column("probed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key"),
    )
    with op.batch_alter_table("identity_provider", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_identity_provider_default_org_id"), ["default_org_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_identity_provider_enabled"), ["enabled"], unique=False)
        batch_op.create_index(batch_op.f("ix_identity_provider_key"), ["key"], unique=True)
        batch_op.create_index(batch_op.f("ix_identity_provider_probe_state"), ["probe_state"], unique=False)

    op.create_table(
        "identity_link",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("provider_id", sa.String(length=36), nullable=False),
        sa.Column("subject", sa.String(length=300), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("email", sa.String(length=300), nullable=False),
        sa.Column("claims_snapshot", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider_id", "subject", name="uq_identity_link_subject"),
    )
    with op.batch_alter_table("identity_link", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_identity_link_provider_id"), ["provider_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_identity_link_user_id"), ["user_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("identity_link", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_identity_link_user_id"))
        batch_op.drop_index(batch_op.f("ix_identity_link_provider_id"))
    op.drop_table("identity_link")
    with op.batch_alter_table("identity_provider", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_identity_provider_probe_state"))
        batch_op.drop_index(batch_op.f("ix_identity_provider_key"))
        batch_op.drop_index(batch_op.f("ix_identity_provider_enabled"))
        batch_op.drop_index(batch_op.f("ix_identity_provider_default_org_id"))
    op.drop_table("identity_provider")
