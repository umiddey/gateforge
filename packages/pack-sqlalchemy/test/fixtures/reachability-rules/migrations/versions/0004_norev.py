from alembic import op


def upgrade():
    op.execute("INSERT INTO norev_rows (id) VALUES (1)")
