import sqlalchemy as sa
from alembic import op

from models import LocalShadowRow

REAL_ROW = LocalShadowRow
revision = "0003_local_table"


def upgrade():
    rows = sa.table("local_table_rows", sa.column("id"))
    op.bulk_insert(rows, [{"id": 1}])
    twice = sa.table("twice_table_rows", sa.column("id"))
    twice = sa.table("twice_table_rows", sa.column("id"))
    op.bulk_insert(twice, [])
    LocalShadowRow = None
    op.bulk_insert(LocalShadowRow, [])
