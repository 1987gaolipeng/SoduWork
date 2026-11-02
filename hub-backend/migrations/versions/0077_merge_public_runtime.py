"""Join public and upstream runtime histories without rewriting applied revisions."""

revision = "0077_merge_public_runtime"
down_revision = (
    "0068_merge_notify_accounts",
    "0069_merge_public_main",
    "0076_merge_model_runtime",
)
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
