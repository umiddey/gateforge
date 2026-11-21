from sqlalchemy import insert, table
from sqlalchemy.orm import Session, sessionmaker

from models import (
    ShadowLocalSessionRow,
    ShadowParamSessionRow,
    ShadowRealSessionmakerRow,
    ShadowRealSessionRow,
    ShadowSessionmakerRow,
)


def make_session():
    return None


def param_session(Session):
    s = Session(None)
    s.add(ShadowParamSessionRow())


def local_session():
    Session = make_session()
    s = Session()
    s.add(ShadowLocalSessionRow())


def param_sessionmaker(sessionmaker):
    s = sessionmaker(None)()
    s.add(ShadowSessionmakerRow())


def param_table(table):
    insert(table("shadow_literal_rows"))


def real_session():
    s = Session(None)
    s.add(ShadowRealSessionRow())


def real_sessionmaker():
    s = sessionmaker(None)()
    s.add(ShadowRealSessionmakerRow())


def real_table():
    insert(table("shadow_real_literal_rows"))
