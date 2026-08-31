"""Legacy-style SQLAlchemy models: declarative_base() factory.

Adversarial coverage:
- literal __tablename__ (resolved)
- declarative_base() base-class alias detection
- __abstract__ = True base class
- plain mixins (no bases) are never tables
- subclass inheriting a literal tablename from an abstract base (the
  graph's symbol table resolves the name; this file contributes the
  class symbol + a typed unresolved entry that the graph retires)
- __table_args__ dict annotation
"""

from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Alpha(Base):
    """Concrete table with a literal tablename."""

    __tablename__ = "alphas"
    __table_args__ = {"schema": "core", "comment": "alpha rows"}
    id = Column(Integer, primary_key=True)
    label = Column(String)


class SoftDeleteMixin:
    """Plain mixin without __abstract__; never a table."""

    deleted_at = Column(String)


class ArchiveBase(Base):
    """Abstract base carrying a literal tablename for inheritance."""

    __abstract__ = True
    __tablename__ = "abstract_never_materialized"
    version = Column(Integer)


class ArchivedAlpha(ArchiveBase):
    """Concrete subclass with its own tablename."""

    __tablename__ = "archived_alphas"
    id = Column(Integer, primary_key=True)


class InheritedAlpha(ArchiveBase):
    """No own tablename; resolves through the abstract base symbol."""

    id = Column(Integer, primary_key=True)