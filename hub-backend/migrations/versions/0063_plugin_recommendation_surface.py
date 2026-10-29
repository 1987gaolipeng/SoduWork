"""Placement slots for page surfaces, decoupled from marketplace featured."""
from alembic import op
import sqlalchemy as sa

revision = '0063_plugin_recommendations'
down_revision = '0062_plugin_recommendation_cover'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'automation_plugin_recommendation',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('org_id', sa.String(36), nullable=True),
        sa.Column('surface', sa.String(24), nullable=False, server_default='compose'),
        sa.Column('kind', sa.String(24), nullable=False, server_default='app'),
        sa.Column('target_type', sa.String(24), nullable=False, server_default='plugin'),
        sa.Column('target_id', sa.String(36), nullable=False),
        sa.Column('title', sa.String(120), nullable=False, server_default=''),
        sa.Column('subtitle', sa.String(240), nullable=False, server_default=''),
        sa.Column('cover_url', sa.String(2048), nullable=False, server_default=''),
        sa.Column('payload', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('sort', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.text('true') if op.get_bind().dialect.name == 'postgresql' else sa.text('1')),
        sa.Column('start_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('end_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.String(64), nullable=False, server_default=''),
        sa.Column('updated_by', sa.String(64), nullable=False, server_default=''),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index('ix_plugin_recommendation_surface', 'automation_plugin_recommendation',
                    ['surface', 'enabled', 'sort', 'id'])
    op.create_index('ix_plugin_recommendation_org', 'automation_plugin_recommendation', ['org_id'])
    op.create_index('ix_plugin_recommendation_target', 'automation_plugin_recommendation',
                    ['target_type', 'target_id'])


def downgrade():
    op.drop_index('ix_plugin_recommendation_target', table_name='automation_plugin_recommendation')
    op.drop_index('ix_plugin_recommendation_org', table_name='automation_plugin_recommendation')
    op.drop_index('ix_plugin_recommendation_surface', table_name='automation_plugin_recommendation')
    op.drop_table('automation_plugin_recommendation')
