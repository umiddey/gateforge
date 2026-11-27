from sqlalchemy import text

from models import UsedThing
from scripts.shared import refresh


def list_things(session):
    return session.query(UsedThing).all()


def count_named(session):
    return session.execute(text("SELECT count(*) FROM named_in_text")).scalar()


def refresh_shared():
    return refresh()
