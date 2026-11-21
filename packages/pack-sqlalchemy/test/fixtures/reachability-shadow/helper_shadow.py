from sqlalchemy import insert

from models import ShadowParamRow, ShadowRealRow


def param_write(insert):
    insert(ShadowParamRow)


def real_write():
    insert(ShadowRealRow)
