"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0022_runner_org_scope"
down_revision: Union[str, Sequence[str], None] = "0021_plugin_catalog_policy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "automation_runner_node"
COLUMN = "org_id"
INDEX = "ix_automation_runner_node_org_id"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns(TABLE)}
    if COLUMN not in columns:
        op.add_column(TABLE, sa.Column(COLUMN, sa.String(length=36), nullable=True))
    indexes = {item["name"] for item in inspect(bind).get_indexes(TABLE)}
    if INDEX not in indexes:
        op.create_index(INDEX, TABLE, [COLUMN], unique=False)

    # Embedded Runners inherit the organization of their authenticated client owner.
    bind.execute(sa.text("""
        UPDATE automation_runner_node
           SET org_id = (
               SELECT app_user.org_id
                 FROM client
                 JOIN app_user ON app_user.id = client.user_ref
                WHERE client.id = automation_runner_node.client_id
           )
         WHERE org_id IS NULL
           AND client_id IS NOT NULL
           AND client_id <> ''
    """))

    # Existing single-company installations (including the team trial server) remain usable.
    # Multi-company databases are intentionally not guessed: their standalone nodes stay
    # unassigned and therefore cannot receive tenant work until an administrator scopes them.
    roots = [row[0] for row in bind.execute(sa.text(
        "SELECT id FROM org_unit WHERE parent_id IS NULL"
    )).fetchall()]
    if len(roots) == 1:
        bind.execute(sa.text("""
            UPDATE automation_runner_node
               SET org_id = :root_id
             WHERE org_id IS NULL
               AND (client_id IS NULL OR client_id = '')
        """), {"root_id": roots[0]})


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE not in inspector.get_table_names():
        return
    indexes = {item["name"] for item in inspector.get_indexes(TABLE)}
    columns = {item["name"] for item in inspector.get_columns(TABLE)}
    with op.batch_alter_table(TABLE, schema=None) as batch_op:
        if INDEX in indexes:
            batch_op.drop_index(INDEX)
        if COLUMN in columns:
            batch_op.drop_column(COLUMN)
