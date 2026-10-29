"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0011_node_run_idempotency"
down_revision: Union[str, Sequence[str], None] = "0010_schedule_creator"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _preserve_legacy_duplicates() -> None:
    """Keep every audit row while freeing its deterministic key for a unique constraint."""
    bind = op.get_bind()
    rows = list(bind.execute(sa.text(
        "SELECT id, idempotency_key FROM automation_node_run "
        "ORDER BY created_at, id"
    )).mappings())
    seen: set[str] = set()
    for row in rows:
        original = str(row["idempotency_key"] or "")
        if original not in seen:
            seen.add(original)
            continue
        suffix = ":legacy:" + str(row["id"])
        rewritten = original[:max(0, 180 - len(suffix))] + suffix
        bind.execute(sa.text(
            "UPDATE automation_node_run SET idempotency_key=:rewritten WHERE id=:id"
        ), {"rewritten": rewritten, "id": row["id"]})
        seen.add(rewritten)


def upgrade() -> None:
    _preserve_legacy_duplicates()
    with op.batch_alter_table("automation_node_run", schema=None) as batch_op:
        batch_op.drop_index("ix_automation_node_run_idempotency_key")
        batch_op.create_unique_constraint(
            "uq_automation_node_run_idempotency_key", ["idempotency_key"])


def downgrade() -> None:
    with op.batch_alter_table("automation_node_run", schema=None) as batch_op:
        batch_op.drop_constraint(
            "uq_automation_node_run_idempotency_key", type_="unique")
        batch_op.create_index(
            "ix_automation_node_run_idempotency_key", ["idempotency_key"], unique=False)
