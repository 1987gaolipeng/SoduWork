"""Join usage/notification history with account-ownership history.

Both heads may already be present in different databases. This merge revision
preserves every released revision and gives future migrations one canonical
parent without replaying schema or data changes.
"""

revision = "0068_merge_notify_accounts"
down_revision = (
    "0065_merge_usage_notifications",
    "0067_merge_account_ownership",
)
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
