import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def upgrade():
    op.create_table("orphan_ledger", sa.Column("id", sa.Integer(), primary_key=True))
    op.create_table("used_things", sa.Column("id", sa.Integer(), primary_key=True))
    op.create_table("named_in_text", sa.Column("id", sa.Integer(), primary_key=True))
    op.create_table("script_only", sa.Column("id", sa.Integer(), primary_key=True))
    op.create_table("imported_script_only", sa.Column("id", sa.Integer(), primary_key=True))
    op.create_table("js_named", sa.Column("id", sa.Integer(), primary_key=True))
    op.create_table("loose_rows", sa.Column("id", sa.Integer(), primary_key=True))


def downgrade():
    pass
