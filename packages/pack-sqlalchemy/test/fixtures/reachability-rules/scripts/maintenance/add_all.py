from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from models import AddAllNegRow, AddAllRow

engine = create_engine("sqlite://")


def write_all():
    session = Session(engine)
    session.add_all([AddAllRow(id=1)])


def write_neg(session):
    rows = [AddAllNegRow(id=1)]
    session.add_all(rows)


if __name__ == "__main__":
    write_all()
    write_neg(None)
