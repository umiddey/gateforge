from sqlalchemy import insert

from models import AmbiguousRow


def write_it(session):
    session.execute(insert(AmbiguousRow).values(id=1))
