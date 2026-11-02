"""App database registry; business tables are provisioned in owned schemas.

Revision ID: jiyong_0001
Revises: None
"""
from alembic import op
import sqlalchemy as sa

revision = 'jiyong_0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('jiyong_spaces',
                    sa.Column('id', sa.String(64), primary_key=True),
                    sa.Column('owner_id', sa.String(180), nullable=False),
                    sa.Column('package_id', sa.String(180), nullable=False),
                    sa.Column('name', sa.String(120), nullable=False),
                    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
                    sa.UniqueConstraint('owner_id', 'package_id', name='uq_jiyong_owner_package'))
    op.create_index('ix_jiyong_spaces_owner', 'jiyong_spaces', ['owner_id'])


def downgrade():
    # Downgrade does not delete any app schemas or business data.
    op.drop_index('ix_jiyong_spaces_owner', table_name='jiyong_spaces')
    op.drop_table('jiyong_spaces')
