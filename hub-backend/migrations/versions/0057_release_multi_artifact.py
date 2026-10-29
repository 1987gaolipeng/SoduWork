"""Allow multiple installer formats for one release target by including artifact_name in
uniqueness. Keep each artifact immutable; update checks use deterministic format preference
while other formats remain downloadable alternatives.
"""
from alembic import op
import sqlalchemy as sa

# Keep revision IDs within the production Alembic version column's 32-character limit.
# SQLite does not enforce that declared length.
# Long IDs would fail PostgreSQL migration-version updates.
revision = "0057_release_multi_artifact"
down_revision = "0056_client_arch"
branch_labels = None
depends_on = None

_OLD = "uq_client_release_target_version"
_NEW = "uq_client_release_target_artifact"
_TABLE = "client_release"


def _unique_names(bind) -> set[str]:
    return {item["name"] for item in sa.inspect(bind).get_unique_constraints(_TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    names = {item["name"] for item in sa.inspect(bind).get_unique_constraints(_TABLE)}
    with op.batch_alter_table(_TABLE, schema=None) as batch:
        if _OLD in names:
            batch.drop_constraint(_OLD, type_="unique")
        if _NEW not in names:
            batch.create_unique_constraint(
                _NEW,
                ["channel", "platform", "arch", "version", "artifact_name"])


def downgrade() -> None:
    bind = op.get_bind()
    names = {item["name"] for item in sa.inspect(bind).get_unique_constraints(_TABLE)}
    with op.batch_alter_table(_TABLE, schema=None) as batch:
        if _NEW in names:
            batch.drop_constraint(_NEW, type_="unique")
    # Restore the old constraint on downgrade only when absent and existing multi-format data does not conflict.
    conflict = bind.execute(sa.text(
        "SELECT channel, platform, arch, version FROM client_release "
        "GROUP BY channel, platform, arch, version HAVING COUNT(*) > 1 LIMIT 1"
    )).first()
    if conflict is None and _OLD not in names:
        with op.batch_alter_table(_TABLE, schema=None) as batch:
            batch.create_unique_constraint(
                _OLD, ["channel", "platform", "arch", "version"])
