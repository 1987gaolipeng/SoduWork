"""Join the model runtime lease branch with the integrated cloud history.

The model runtime tables were developed from the pre-cloud ``0073`` head,
while main integrated the cloud durability and personal relay branches into
``0075_merge_cloud_relay``.  Keep both parent migrations intact and publish a
single head for future schema changes.
"""

revision = "0076_merge_model_runtime"
down_revision = ("0074_model_runtime_leases", "0075_merge_cloud_relay")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
