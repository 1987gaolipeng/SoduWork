"""Persist the architecture reported by each SoduWork client."""
from alembic import op
import sqlalchemy as sa

revision = "0056_client_arch"
down_revision = "0055_runner_personal_owner"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("client", sa.Column("arch", sa.String(length=16), nullable=True))
    op.create_index("ix_client_arch", "client", ["arch"], unique=False)


def downgrade():
    op.drop_index("ix_client_arch", table_name="client")
    op.drop_column("client", "arch")
