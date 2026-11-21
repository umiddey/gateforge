from sqlalchemy import insert

from models import ShadowDefRow

REAL_INSERT = insert


def _stub(model):
    return None


insert = _stub


def def_write():
    insert(ShadowDefRow)
