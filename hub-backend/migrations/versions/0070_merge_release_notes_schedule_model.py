"""Join the release-notes and automation model-selection migration heads."""

revision = "0070_merge_notes_schedule"
down_revision = ("0069_client_release_notes", "0069_schedule_model_selection")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Both parent migrations already applied their own schema changes."""


def downgrade() -> None:
    """The parent revisions own their respective DDL."""
