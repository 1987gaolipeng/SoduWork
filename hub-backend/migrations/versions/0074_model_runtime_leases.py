"""Move model admission state out of the AppSetting JSON row."""
from alembic import op
import sqlalchemy as sa


revision = "0074_model_runtime_leases"
down_revision = "0073_remote_screen_grants"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "model_runtime_lease",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
        sa.Column("provider", sa.String(80), nullable=False, server_default=""),
        sa.Column("model", sa.String(160), nullable=False, server_default=""),
        sa.Column("global_scope", sa.String(96), nullable=False, server_default="all"),
        sa.Column("provider_scope", sa.String(96), nullable=False, server_default=""),
        sa.Column("key_scope", sa.String(96), nullable=False, server_default=""),
        sa.Column("model_scope", sa.String(96), nullable=False, server_default=""),
        sa.Column("user_scope", sa.String(96), nullable=False, server_default=""),
        sa.Column("global_limit", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("provider_limit", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("key_limit", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("model_limit", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("user_limit", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_index("ix_model_runtime_lease_state_created", "model_runtime_lease",
                    ["state", "created_at", "id"])
    op.create_index("ix_model_runtime_lease_state_expires", "model_runtime_lease",
                    ["state", "expires_at"])
    for suffix, scope in (("provider", "provider_scope"), ("key", "key_scope"),
                          ("model", "model_scope"), ("user", "user_scope")):
        op.create_index(f"ix_model_runtime_lease_state_{suffix}", "model_runtime_lease",
                        ["state", scope])
    op.create_table(
        "model_runtime_metric",
        sa.Column("bucket", sa.BigInteger(), primary_key=True),
        sa.Column("name", sa.String(32), primary_key=True),
        sa.Column("value", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_model_runtime_metric_name_bucket", "model_runtime_metric", ["name", "bucket"])


def downgrade() -> None:
    op.drop_index("ix_model_runtime_metric_name_bucket", table_name="model_runtime_metric")
    op.drop_table("model_runtime_metric")
    for name in ("user", "model", "key", "provider"):
        op.drop_index(f"ix_model_runtime_lease_state_{name}", table_name="model_runtime_lease")
    op.drop_index("ix_model_runtime_lease_state_expires", table_name="model_runtime_lease")
    op.drop_index("ix_model_runtime_lease_state_created", table_name="model_runtime_lease")
    op.drop_table("model_runtime_lease")
