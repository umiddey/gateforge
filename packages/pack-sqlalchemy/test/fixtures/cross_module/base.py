"""Cross-module inheritance: models/base.py declares the shared abstract
base; models/child.py declares subclasses in ANOTHER file.

The spike's detector could not resolve cross-file inheritance
(limitation 1); the graph's repo-wide symbol table resolves it. This
file contributes class symbols + typed unresolved entries; the graph
materializes the child table when the base chain carries a literal.
"""

from sqlalchemy import Column, Integer
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Repo-wide base; never materializes."""

    pass


class ArchiveBase(Base):
    """Abstract base with a literal tablename; subclasses inherit it."""

    __abstract__ = True
    __tablename__ = "archive_rows"
    version = Column(Integer)