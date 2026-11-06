"""Bound source discovery and expired-grant cleanup by source/state/expiry."""
from alembic import op
from contextlib import contextmanager
import sqlalchemy as sa

revision = "0079_native_discovery"
down_revision = "0078_account_task_projection"
branch_labels = None
depends_on = None
INDEX = "ix_remote_screen_source_state_expiry"


@contextmanager
def index_window():
    pg = op.get_bind().dialect.name == "postgresql"
    if not pg:
        yield False
        return
    # Match the bounded concurrent-index policy in 0037_hot_path_indexes.
    with op.get_context().autocommit_block():
        connection = op.get_bind()
        previous = connection.execute(sa.text(
            "SELECT current_setting('statement_timeout'), current_setting('lock_timeout')")).one()
        connection.execute(sa.text("SELECT set_config('statement_timeout', '30min', false), "
                                   "set_config('lock_timeout', '5s', false)"))
        try:
            yield True
        finally:
            connection.execute(sa.text("SELECT set_config('statement_timeout', :statement, false), "
                                       "set_config('lock_timeout', :lock, false)"),
                               {"statement": previous[0], "lock": previous[1]})


def upgrade():
    with index_window() as pg:
        if pg:
            valid = op.get_bind().execute(sa.text(
                "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid "
                "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=:name "
                "AND n.nspname=current_schema()"), {"name": INDEX}).scalar()
            if valid is False:
                op.execute(sa.text(f'DROP INDEX CONCURRENTLY "{INDEX}"'))
        op.create_index(INDEX, "remote_screen_grant", ["source_client_id", "state", "expires_at"],
                        if_not_exists=True, **({"postgresql_concurrently": True} if pg else {}))


def downgrade():
    with index_window() as pg:
        op.drop_index(INDEX, table_name="remote_screen_grant", if_exists=True,
                      **({"postgresql_concurrently": True} if pg else {}))
