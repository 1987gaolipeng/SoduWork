"""Join public runtime and upstream conversation projects without changing applied IDs."""

revision = "0079_merge_public_projects"
down_revision = ("0077_merge_public_runtime", "0078_account_task_projection")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
