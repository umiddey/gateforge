"""A pytest module that DECLARES a table named like the real one.

This is the pattern that used to break the gate: a test fixture re-declares
``accounts`` (on its own Base) so the test can build rows without touching
the application's metadata. The fixture is not business surface — it must
never enter the resource graph, and it must not make the real ``accounts``
resource collide.
"""
from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Account(Base):
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True)
    name = Column(String(64))