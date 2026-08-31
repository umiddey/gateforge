"""Modern-style SQLAlchemy models: DeclarativeBase superclass and raw Table().

Adversarial coverage:
- DeclarativeBase subclass used as base class (pure base, never a table)
- table name "shared_items" (cross-file duplicate with collisions.py)
- direct sqlalchemy.Table() declaration outside declarative classes
- class keyword table=True (SQLModel-style, no __tablename__)
"""

from sqlalchemy import Column, Integer, MetaData, String, Table
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Beta(Base):
    """Duplicate table name with collisions.SharedItems."""

    __tablename__ = "shared_items"
    id = Column(Integer, primary_key=True)


user_prefs = Table(
    "user_prefs",
    MetaData(),
    Column("id", Integer, primary_key=True),
    Column("pref", String),
)


class SqlModelStyleRow(Base, table=True):
    """SQLModel-style class keyword table=True; no __tablename__ declared."""

    id = Column(Integer, primary_key=True)