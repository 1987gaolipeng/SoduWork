"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0013_client_full_updates"
down_revision: Union[str, Sequence[str], None] = "0012_personal_capabilities"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "client_release",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("channel", sa.String(16), nullable=False, server_default="stable"),
        sa.Column("platform", sa.String(16), nullable=False, server_default="win32"),
        sa.Column("arch", sa.String(16), nullable=False, server_default="x64"),
        sa.Column("artifact_name", sa.String(160), nullable=False),
        sa.Column("artifact_path", sa.String(400), nullable=False),
        sa.Column("artifact_size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("signature", sa.String(128), nullable=False),
        sa.Column("key_id", sa.String(64), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("mandatory", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("min_version", sa.String(32), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.String(36), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.UniqueConstraint("channel", "platform", "arch", "version",
                            name="uq_client_release_target_version"),
    )
    for name, columns in (
        ("ix_client_release_version", ["version"]),
        ("ix_client_release_channel", ["channel"]),
        ("ix_client_release_platform", ["platform"]),
        ("ix_client_release_arch", ["arch"]),
        ("ix_client_release_enabled", ["enabled"]),
    ):
        op.create_index(name, "client_release", columns)

    op.create_table(
        "client_update_attempt",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("client_id", sa.String(64),
                  sa.ForeignKey("client.id", ondelete="CASCADE"), nullable=False),
        sa.Column("release_id", sa.String(36),
                  sa.ForeignKey("client_release.id"), nullable=False),
        sa.Column("requested_by", sa.String(36), nullable=False, server_default=""),
        sa.Column("current_version", sa.String(32), nullable=False, server_default=""),
        sa.Column("target_version", sa.String(32), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.String(600), nullable=False, server_default=""),
        sa.Column("detail", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    for name, columns in (
        ("ix_client_update_attempt_client_id", ["client_id"]),
        ("ix_client_update_attempt_release_id", ["release_id"]),
        ("ix_client_update_attempt_state", ["state"]),
    ):
        op.create_index(name, "client_update_attempt", columns)


def downgrade() -> None:
    op.drop_table("client_update_attempt")
    op.drop_table("client_release")
