from sqlalchemy import create_engine, orm
from sqlalchemy.orm import Session, sessionmaker

from models import AliasRow, AttrRow, HelperSessionRow, MakerRow, OrmSessionRow, ParamRow, PlainRow, TwiceRow

engine = create_engine("sqlite://")
SESSION = Session(engine)
maker = sessionmaker(engine)


def make_session():
    return Session(engine)


class Holder:
    def __init__(self):
        self.session = Session(engine)

    def write(self):
        self.session.add(AttrRow(id=1))


def use_param(session: Session):
    session.add(ParamRow(id=1))


def use_maker():
    with maker() as s:
        s.add(MakerRow(id=1))


def use_twice():
    s = Session(engine)
    s = make_session()
    s.add(TwiceRow(id=1))


def use_alias():
    SESSION.add(AliasRow(id=1))


def use_helper():
    s = make_session()
    s.add(HelperSessionRow(id=1))


def use_orm(session: orm.Session):
    session.add(OrmSessionRow(id=1))


s2 = Session(engine)
s2.add(PlainRow(id=1))


if __name__ == "__main__":
    use_param(None)
    use_maker()
    use_twice()
    use_alias()
    use_helper()
    use_orm(None)
    Holder().write()
