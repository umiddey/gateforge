import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def _seed():
    op.bulk_insert(sa.table("seed_codes", sa.column("code")), [{"code": "A"}])


def upgrade():
    op.create_table("orphan_rows", sa.Column("id", sa.Integer(), primary_key=True))
    _seed()
    op.execute("INSERT INTO dup_rows (id) VALUES (1)")


def downgrade():
    pass
