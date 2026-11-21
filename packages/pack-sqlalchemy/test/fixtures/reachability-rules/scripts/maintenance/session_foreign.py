from mylib import Session, orm

from models import ForeignOrmSessionRow, ForeignSessionRow


def f(session: Session):
    session.add(ForeignSessionRow(id=1))


def g(session: orm.Session):
    session.add(ForeignOrmSessionRow(id=1))


if __name__ == "__main__":
    f(None)
    g(None)
