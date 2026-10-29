"""Public module behavior and service contracts."""
from typing import Sequence, Union
import hashlib

from alembic import op
import sqlalchemy as sa


revision: str = "0005_device_security"
down_revision: Union[str, Sequence[str], None] = "0004_identity_foundation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("client", schema=None) as batch_op:
        batch_op.add_column(sa.Column("secret_hash", sa.String(length=64), nullable=False,
                                      server_default=""))
        batch_op.add_column(sa.Column("auth_state", sa.String(length=16), nullable=False,
                                      server_default="pending"))
        batch_op.add_column(sa.Column("auth_version", sa.Integer(), nullable=False,
                                      server_default="1"))
        batch_op.add_column(sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.create_index(batch_op.f("ix_client_auth_state"), ["auth_state"], unique=False)

    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, secret, user_ref FROM client")).mappings().all()
    for row in rows:
        raw = str(row.get("secret") or "")
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest() if raw else ""
        state = "active" if digest and row.get("user_ref") else "pending"
        bind.execute(sa.text(
            "UPDATE client SET secret_hash=:digest, auth_state=:state, "
            "activated_at=CASE WHEN :activate "
            "THEN COALESCE(activated_at,CURRENT_TIMESTAMP) ELSE NULL END "
            "WHERE id=:id"
        ), {"digest": digest, "state": state, "activate": state == "active", "id": row["id"]})
    # Compatibility validates the presented key against ``secret_hash``. Keep
    # the nullable column only for the bounded rollout, never its plaintext.
    bind.execute(sa.text("UPDATE client SET secret=NULL"))

    with op.batch_alter_table("app_user", schema=None) as batch_op:
        batch_op.add_column(sa.Column("auth_version", sa.Integer(), nullable=False,
                                      server_default="1"))


def downgrade() -> None:
    with op.batch_alter_table("app_user", schema=None) as batch_op:
        batch_op.drop_column("auth_version")
    with op.batch_alter_table("client", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_client_auth_state"))
        batch_op.drop_column("revoked_at")
        batch_op.drop_column("activated_at")
        batch_op.drop_column("auth_version")
        batch_op.drop_column("auth_state")
        batch_op.drop_column("secret_hash")
