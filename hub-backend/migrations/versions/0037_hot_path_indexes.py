"""Composite indexes for measured read paths and bounded workflow polling."""
from contextlib import contextmanager
from alembic import op
import sqlalchemy as sa

revision = "0037_hot_path_indexes"
down_revision = "0036_project_context"
branch_labels = None
depends_on = None

_INDEXES = (
    ("ix_task_owner_state_updated", "task", ["owner_client_id","status","updated_at","id"]),
    ("ix_task_event_timeline", "task_event", ["task_id","at","id"]),
    ("ix_task_comment_timeline", "task_comment", ["task_id","created_at","id"]),
    ("ix_workflow_outbox_due", "automation_workflow_outbox", ["status","available_at","created_at"]),
    ("ix_workflow_task_latest", "automation_workflow_run", ["task_id","created_at","id"]),
    ("ix_node_run_attempt", "automation_node_run", ["run_id","node_key","attempt"]),
    ("ix_execution_task_latest", "automation_execution_session", ["task_id","started_at","created_at"]),
    ("ix_execution_runner_active", "automation_execution_session", ["runner_id","state","last_event_at"]),
)


@contextmanager
def _ddl_window():
    pg = op.get_bind().dialect.name == "postgresql"
    with op.get_context().autocommit_block():
        connection = op.get_bind()
        previous = None
        if pg:
            previous = connection.execute(sa.text(
                "SELECT current_setting('statement_timeout'), current_setting('lock_timeout')"
            )).one()
            connection.execute(sa.text(
                "SELECT set_config('statement_timeout', '30min', false), "
                "set_config('lock_timeout', '5s', false)"
            ))
        try:
            yield pg
        finally:
            if previous is not None:
                connection.execute(sa.text(
                    "SELECT set_config('statement_timeout', :statement, false), "
                    "set_config('lock_timeout', :lock, false)"
                ), {"statement": previous[0], "lock": previous[1]})


def upgrade():
    # DDL has its own bounded timeout; a role's short API timeout must not kill it.
    with _ddl_window() as pg:
        for name, table, columns in _INDEXES:
            if pg:
                valid = op.get_bind().execute(sa.text(
                    "SELECT i.indisvalid FROM pg_index i JOIN pg_class c "
                    "ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace "
                    "WHERE c.relname=:name AND n.nspname=current_schema()"),
                    {"name": name}).scalar()
                if valid is False:  # interrupted concurrent build, not a usable index
                    op.execute(sa.text(f'DROP INDEX CONCURRENTLY "{name}"'))
            op.create_index(name, table, columns, if_not_exists=True,
                            **({"postgresql_concurrently": True} if pg else {}))


def downgrade():
    with _ddl_window() as pg:
        for name, table, _ in reversed(_INDEXES):
            op.drop_index(name, table_name=table, if_exists=True,
                          **({"postgresql_concurrently": True} if pg else {}))
