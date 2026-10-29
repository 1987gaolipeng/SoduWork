"""Join both integrated histories without changing an already applied revision.

Notification compatibility and opt-in IM revisions can already be applied to
an existing database. Keep their identities reachable alongside the account
merge so startup can upgrade each history without deleting tables or stamping
over a database's recorded state.
"""

revision = "0068_merge_notification_account"
down_revision = (
    "0067_merge_release_account_ownership",
    "0066_merge_im_transport",
)
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
