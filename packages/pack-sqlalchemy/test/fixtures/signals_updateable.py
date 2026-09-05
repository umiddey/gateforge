"""Machine-readable updateable-field declarations (phase 7 dogfood).

``__gateforge_updateable_fields__ = (<field>, ...)`` is an owner-owned
ASSERTION naming the fields a UI update flow actually changes. The core
classifier copies the attribute into the resource lifecycle
(``updateableFields``), where the verdict engine's update postcondition
requires it (fail closed when absent). It rides ATTRIBUTES — never
semantics — and is never guessed:

- a list/tuple of distinct non-empty string literals is copied verbatim;
- a non-literal or empty declaration contributes NOTHING (no attribute),
  never a partial guess.
"""

from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Department(Base):
    """Tuple declaration in written order."""

    __tablename__ = "departments"
    id = Column(Integer, primary_key=True)
    name = Column(String)
    description = Column(String)
    __gateforge_updateable_fields__ = ("name", "description")


class Settings(Base):
    """List declaration."""

    __tablename__ = "settings"
    id = Column(Integer, primary_key=True)
    theme = Column(String)
    __gateforge_updateable_fields__ = ["theme"]


class ComputedFields(Base):
    """Non-literal declaration: no attribute, never guessed."""

    __tablename__ = "computed_fields"
    id = Column(Integer, primary_key=True)
    __gateforge_updateable_fields__ = derive_fields()


class EmptyFields(Base):
    """Empty declaration: no attribute."""

    __tablename__ = "empty_fields"
    id = Column(Integer, primary_key=True)
    __gateforge_updateable_fields__ = []
