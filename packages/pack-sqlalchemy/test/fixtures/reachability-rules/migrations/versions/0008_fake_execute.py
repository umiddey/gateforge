from mylib import op

revision = "0008"
down_revision = "0007"


def upgrade():
    op.execute("INSERT INTO fake_exec_rows (id) VALUES (1)")
