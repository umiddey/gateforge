from sqlalchemy import insert

from models import HelperRow


def register(fn):
    return fn


def write_static(session):
    session.execute(insert(HelperRow).values(id=1))
