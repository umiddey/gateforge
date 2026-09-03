"""Computed or invisible primary keys (plan phase 3): typed unresolved.

- a ``primary_key`` argument that is not the literal True is computed —
  the ordered key is never guessed (GF-21 mechanic for keys);
- a table with NO visible primary-key column (an inherited mixin/base
  key is not visible to the AST scan) is typed unresolved — the key is
  never defaulted to ``id`` (plan §4.3 / ADR 0003 D2).
"""

from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def use_uuid_pk():
    return True


class ComputedPk(Base):
    """The primary_key argument is computed."""

    __tablename__ = "computed_pks"
    id = Column(Integer, primary_key=use_uuid_pk())


class InheritedPk(Base):
    """No visible primary-key column at all (key would be inherited)."""

    __tablename__ = "inherited_pks"
    created_at = Column(String)
