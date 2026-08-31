"""Computed table names (GF-02/GF-21): every one must be reported as a
typed unresolved entry, never guessed, never dropped silently.

- decorated __tablename__ function with 3 nested decorators
  (declared_attr pattern; the reason must keep the decorator count and
  the return-expression kind — no signature truncation)
- __tablename__ assigned from an f-string
- __tablename__ assigned from an arbitrary call expression
- __tablename__ assigned from a name reference
"""

from sqlalchemy import Column, Integer
from sqlalchemy.orm import DeclarativeBase, declared_attr


class Base(DeclarativeBase):
    pass


def _registry_key(cls):
    return cls.__name__.lower()


def _memoize(fn):
    return fn


class Widget(Base):
    """Nested decorators over a __tablename__ function (declared_attr)."""

    id = Column(Integer, primary_key=True)

    @_memoize
    @_registry_key
    @declared_attr
    def __tablename__(cls):
        return "widget_" + cls.__name__.lower()


class Gadget(Base):
    """F-string tablename."""

    __tablename__ = f"gadgets_v1"
    id = Column(Integer, primary_key=True)


class Gizmo(Base):
    """Call-expression tablename."""

    __tablename__ = resolve_tablename("gizmo")
    id = Column(Integer, primary_key=True)


class Doohickey(Base):
    """Name-reference tablename."""

    __tablename__ = doohickey_table_name
    id = Column(Integer, primary_key=True)