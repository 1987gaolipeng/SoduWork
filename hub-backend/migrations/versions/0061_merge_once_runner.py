"""Merge fixed-date schedules and managed-runner security without rewriting either branch."""

revision = "0061_merge_once_runner"
down_revision = ("0060_schedule_once", "0060_runner_management")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
