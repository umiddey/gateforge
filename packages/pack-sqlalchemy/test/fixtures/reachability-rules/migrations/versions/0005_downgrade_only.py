from alembic import op

revision = "0005"
down_revision = "0004"


def upgrade():
    pass


def downgrade():
    op.execute("INSERT INTO downgrade_rows (id) VALUES (1)")
