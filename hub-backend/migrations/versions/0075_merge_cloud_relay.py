"""Join cloud execution durability and personal conversation relay migrations."""

# Both feature branches extended 0073 independently. This revision is a
# schema-only graph merge; each parent migration still runs in full.
revision = "0075_merge_cloud_relay"
down_revision = ("0074_cloud_execution_durability", "0074_personal_conversation_relay")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
