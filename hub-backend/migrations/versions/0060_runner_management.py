"""Administrator lifecycle for personally enrolled cloud runners."""
from alembic import op
import sqlalchemy as sa

revision = "0060_runner_management"
down_revision = "0059_identity_key_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("automation_runner_node", sa.Column(
        "management_state", sa.String(24), nullable=False, server_default=""))


def downgrade() -> None:
    # Downgrading a managed inventory would remove its security boundary.
    count = op.get_bind().execute(sa.text(
        "SELECT count(*) FROM automation_runner_node WHERE management_state <> ''"
    )).scalar()
    if count:
        raise RuntimeError("Managed cloud runners must be resolved before downgrade")
    op.drop_column("automation_runner_node", "management_state")
