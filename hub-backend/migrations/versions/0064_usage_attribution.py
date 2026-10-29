"""Freeze daily usage attribution and distinguish unreported cost from zero."""
from alembic import op
import sqlalchemy as sa

revision = '0064_usage_attribution'
down_revision = '0063_task_notification_outbox'
branch_labels = None
depends_on = None

FIELDS = {'billing_user_id': 36, 'org_id': 36, 'client_id': 64,
          'agent_key': 60, 'provider': 60, 'model': 160, 'source_type': 32}


def _upgrade(operations):
    with operations.batch_alter_table('ai_usage_daily') as batch:
        batch.add_column(sa.Column('dimension_key', sa.String(64), nullable=False, server_default=''))
        for field, size in FIELDS.items():
            batch.add_column(sa.Column(field, sa.String(size), nullable=False, server_default=''))
        batch.add_column(sa.Column('cost_known', sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.drop_constraint('uq_ai_usage_daily_event_day', type_='unique')
        batch.create_unique_constraint('uq_ai_usage_daily_dimension', ['usage_event_id', 'day_key', 'dimension_key'])
        batch.create_index('ix_ai_usage_daily_user_day', ['billing_user_id', 'day_key'])
    backfill_dimensions(operations.get_bind())


def backfill_dimensions(bind):
    meta = sa.MetaData()
    daily = sa.Table('ai_usage_daily', meta, autoload_with=bind)
    events = sa.Table('ai_usage_event', meta, autoload_with=bind)
    # Historical rows retain the last known attribution. Do not invent a model
    # split that the old schema never recorded, or infer known zero prices.
    bind.execute(daily.update().where(daily.c.dimension_key == '').values({field: sa.select(events.c[field]).where(
        events.c.id == daily.c.usage_event_id).scalar_subquery() for field in FIELDS}))
    bind.execute(daily.update().where(daily.c.dimension_key == '', daily.c.cost_microusd > 0).values(cost_known=True))


def upgrade():
    _upgrade(op)


def adopt(bind):
    # Only explicit pre-Alembic adoption uses this helper; normal startup runs
    # the numbered migration before accepting accounting writes.
    if 'dimension_key' not in {column['name'] for column in sa.inspect(bind).get_columns('ai_usage_daily')}:
        from alembic.operations import Operations
        from alembic.migration import MigrationContext
        _upgrade(Operations(MigrationContext.configure(bind)))
    backfill_dimensions(bind)


def downgrade():
    bind = op.get_bind()
    duplicate = bind.execute(sa.text('SELECT usage_event_id FROM ai_usage_daily '
        'GROUP BY usage_event_id, day_key HAVING COUNT(*) > 1 LIMIT 1')).first()
    if duplicate:
        raise RuntimeError('Cannot discard attributed usage; restore the matching backup to roll back')
    with op.batch_alter_table('ai_usage_daily') as batch:
        batch.drop_index('ix_ai_usage_daily_user_day')
        batch.drop_constraint('uq_ai_usage_daily_dimension', type_='unique')
        for field in ['dimension_key', *FIELDS, 'cost_known']:
            batch.drop_column(field)
        batch.create_unique_constraint('uq_ai_usage_daily_event_day', ['usage_event_id', 'day_key'])
