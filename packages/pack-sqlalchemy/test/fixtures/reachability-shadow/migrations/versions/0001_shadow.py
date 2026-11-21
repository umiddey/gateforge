from alembic import op
from sqlalchemy import insert

from helper_shadow import param_write, real_write
from models import ShadowLocalRow
from override_shadow import def_write

REAL_INSERT = insert
revision = "0001_shadow"


def upgrade():
    param_write(print)
    def_write()
    real_write()
    op.execute('INSERT INTO "route rows" (id) VALUES (1)')
    op.execute("UPDATE ONLY only_rows SET id = 1")

    def insert(model):
        return None

    insert(ShadowLocalRow)
