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

    def insert(model):
        return None

    insert(ShadowLocalRow)
