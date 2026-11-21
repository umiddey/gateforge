revision = "0009"
down_revision = "0008"


class FakeOp:
    def execute(self, sql):
        return sql


op = FakeOp()


def upgrade():
    op.execute("INSERT INTO local_exec_rows (id) VALUES (1)")
