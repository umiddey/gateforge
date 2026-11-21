from alembic import op

revision = 6
down_revision = "0005"


def upgrade():
    op.execute("INSERT INTO nonstring_rows (id) VALUES (1)")
