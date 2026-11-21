from alembic import op

if True:
    revision = "0007"
down_revision = "0006"


def upgrade():
    op.execute("INSERT INTO nested_rev_rows (id) VALUES (1)")
