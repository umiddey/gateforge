"""Genuine candidate shapes (phase 2, detector precision): the positive matrix.

Every class below MUST still be recognized under the precise predicate:

- ``LegacyBase = declarative_base()`` alias (legacy declarative style);
- ``class ModernBase(DeclarativeBase)`` style (SQLAlchemy 2.0) — the
  base class itself stays a pure base (a symbol, never a table);
- ``class User(LegacyBase)`` declarative WITHOUT ``__tablename__`` —
  genuine but unresolved (``no_tablename_source``; the graph's symbol
  table owns naming — never auto-derived here, that is a later phase);
- ``class Account(LegacyBase)`` WITH a literal ``__tablename__``;
- inheritance closure: ``class SalariedEmployee(Account)`` has no facts
  of its own but inherits candidacy from a detected model class;
- ``registry().generate_base()`` alias (SQLAlchemy 2.0 mapped registry);
- the conventional cross-file ``Base`` (``from app.db import Base`` is
  statically unresolvable in a flat scan; the exact name is the
  universal SQLAlchemy convention and deliberately counts);
- mixin mixing: ``class AuditedRow(Base, TimestampMixin)``;
- a direct ``Table(...)`` declaration (non-class candidate);
- ``__abstract__ = True`` bases stay pure (no table resource).
"""

from sqlalchemy import Column, Integer, MetaData, String, Table
from sqlalchemy.orm import DeclarativeBase, declarative_base, registry
from app.db import Base

LegacyBase = declarative_base()


class User(LegacyBase):
    """Legacy declarative WITHOUT __tablename__: genuine but unresolved."""

    id = Column(Integer, primary_key=True)


class Account(LegacyBase):
    """Legacy declarative WITH a literal tablename."""

    __tablename__ = "candidate_accounts"
    id = Column(Integer, primary_key=True)
    label = Column(String)


class ModernBase(DeclarativeBase):
    """DeclarativeBase subclass: pure base — a symbol, never a table."""


class Profile(ModernBase):
    """Modern declarative WITHOUT __tablename__: genuine but unresolved."""

    id = Column(Integer, primary_key=True)


class SalariedEmployee(Account):
    """Inheritance closure: candidacy inherited from a detected model."""

    id = Column(Integer, primary_key=True)


mapper_registry = registry()
TenantModel = mapper_registry.generate_base()


class Tenant(TenantModel):
    """Registry-generated declarative base WITHOUT __tablename__."""

    id = Column(Integer, primary_key=True)


class TimestampMixin:
    """A plain mixin: NOT a candidate (no bases, no facts)."""

    created_at = Column(String)


class AuditedRow(Base, TimestampMixin):
    """Conventional cross-file Base plus a mixin, WITH a literal name."""

    __tablename__ = "candidate_audit_rows"
    id = Column(Integer, primary_key=True)
    action = Column(String)


class AbstractShape(Base):
    """An abstract base: pure — a symbol, never a table resource."""

    __abstract__ = True
    version = Column(Integer)


event_log = Table(
    "candidate_event_log",
    MetaData(),
    Column("id", Integer, primary_key=True),
    Column("detail", String),
)
