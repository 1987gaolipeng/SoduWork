"""Join public source migrations and upstream native discovery without rewriting history."""

revision = "0080_merge_public_discovery"
down_revision = ("0079_merge_public_projects", "0079_native_discovery")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
