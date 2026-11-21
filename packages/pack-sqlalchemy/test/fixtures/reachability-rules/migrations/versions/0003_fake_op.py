from mylib import op

from models import FakeOpRow

revision = "0003"
down_revision = "0002"


def upgrade():
    op.bulk_insert(FakeOpRow, [{"id": 1}])
