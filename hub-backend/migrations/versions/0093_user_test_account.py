"""Store an administrator's test account designation without guessing for existing users."""
from alembic import op
import sqlalchemy as sa

revision = "0093_user_test_account"
down_revision = "0092_task_text_storage"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("app_user", sa.Column("is_test_account", sa.Boolean(), nullable=True))


def downgrade():
    op.drop_column("app_user", "is_test_account")
