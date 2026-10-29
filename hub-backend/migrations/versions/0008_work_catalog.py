"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0008_work_catalog"
down_revision: Union[str, Sequence[str], None] = "0007_periodic_work_reports"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("position", schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            "org_id", sa.String(length=36), nullable=True))
        batch_op.add_column(sa.Column(
            "category", sa.String(length=40), nullable=False,
            server_default=sa.text("''")))
        batch_op.add_column(sa.Column(
            "description", sa.String(length=400), nullable=False,
            server_default=sa.text("''")))
        batch_op.add_column(sa.Column(
            "competencies", sa.JSON(), nullable=False,
            server_default=sa.text("'[]'")))
        batch_op.create_index(
            batch_op.f("ix_position_org_id"), ["org_id"], unique=False)

    with op.batch_alter_table("task", schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            "work_scenario_key", sa.String(length=80), nullable=False,
            server_default=sa.text("''")))
        batch_op.add_column(sa.Column(
            "work_scenario_name", sa.String(length=100), nullable=False,
            server_default=sa.text("''")))
        batch_op.add_column(sa.Column(
            "work_routing", sa.JSON(), nullable=False,
            server_default=sa.text("'{}'")))
        batch_op.create_index(
            batch_op.f("ix_task_work_scenario_key"),
            ["work_scenario_key"], unique=False)

    op.create_table(
        "work_scenario",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=True),
        sa.Column("key", sa.String(length=80), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("category", sa.String(length=40), nullable=False,
                  server_default=sa.text("''")),
        sa.Column("description", sa.String(length=500), nullable=False,
                  server_default=sa.text("''")),
        sa.Column("position_ids", sa.JSON(), nullable=False,
                  server_default=sa.text("'[]'")),
        sa.Column("intent_hints", sa.JSON(), nullable=False,
                  server_default=sa.text("'[]'")),
        sa.Column("required_capabilities", sa.JSON(), nullable=False,
                  server_default=sa.text("'[]'")),
        sa.Column("default_plugin_key", sa.String(length=100), nullable=False,
                  server_default=sa.text("''")),
        sa.Column("output_contract", sa.JSON(), nullable=False,
                  server_default=sa.text("'{}'")),
        sa.Column("enabled", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column("is_system", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("sort", sa.Integer(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "org_id", "key", name="uq_work_scenario_org_key"),
    )
    with op.batch_alter_table("work_scenario", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_work_scenario_enabled"),
            ["enabled"], unique=False)
        batch_op.create_index(
            batch_op.f("ix_work_scenario_key"), ["key"], unique=False)
        batch_op.create_index(
            batch_op.f("ix_work_scenario_org_id"), ["org_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("work_scenario", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_work_scenario_org_id"))
        batch_op.drop_index(batch_op.f("ix_work_scenario_key"))
        batch_op.drop_index(batch_op.f("ix_work_scenario_enabled"))
    op.drop_table("work_scenario")

    with op.batch_alter_table("task", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_task_work_scenario_key"))
        batch_op.drop_column("work_routing")
        batch_op.drop_column("work_scenario_name")
        batch_op.drop_column("work_scenario_key")

    with op.batch_alter_table("position", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_position_org_id"))
        batch_op.drop_column("competencies")
        batch_op.drop_column("description")
        batch_op.drop_column("category")
        batch_op.drop_column("org_id")
