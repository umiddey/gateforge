"""Duplicate-table-name fixtures (GF-20).

- same table name "shared_items" in a different file (cross-file
  duplicate with modern_declarative.py: 2-file variant)
- same table name "dupes" declared twice in this file (1-file variant)
"""

from sqlalchemy import Column, Integer
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class SharedItems(Base):
    """First declaration of table 'shared_items' in this file."""

    __tablename__ = "shared_items"
    id = Column(Integer, primary_key=True)


class SharedItemsMirror(Base):
    """First declaration of table 'dupes' in the same file."""

    __tablename__ = "dupes"
    id = Column(Integer, primary_key=True)


class SharedItemsReplica(Base):
    """Second declaration of table 'dupes' in the same file."""

    __tablename__ = "dupes"
    id = Column(Integer, primary_key=True)