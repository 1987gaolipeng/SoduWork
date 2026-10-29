"""Add editable recommendation artwork without changing immutable packages."""
from alembic import op
import sqlalchemy as sa

revision = '0062_plugin_recommendation_cover'
down_revision = '0061_merge_once_runner'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('automation_plugin_catalog_policy', sa.Column('cover_url', sa.String(2048), nullable=False, server_default=''))


def downgrade():
    op.drop_column('automation_plugin_catalog_policy', 'cover_url')
