"""Machine-readable archive/lifecycle declarations (plan phase 3).

Declarations are ASSERTIONS the core classifier consumes conservatively
(ADR 0003 D5) — never suppressions on their own:

- ``__gateforge_archive_state__ = {<field>: <literal>}`` plus
  ``__gateforge_delete_semantics__ = "archive"`` — proven archive
  semantics with owner-owned archived field values;
- ``__gateforge_delete_semantics__ = "hard"`` — proven hard delete;
- ``__gateforge_read_only__ = True`` — lifecycle create/update/delete
  asserted unsupported (the classifier keeps operations enabled by
  default; a lone declaration never disables anything);
- a soft-delete candidate column WITHOUT any declaration is only an
  attribute fact (``softDeleteCandidateFields``), never semantics;
- a NON-LITERAL archive declaration is a typed unresolved entry — the
  archived state is never guessed.
"""

from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class ArchivedDoc(Base):
    """Archive semantics with owner-owned archived state."""

    __tablename__ = "archived_docs"
    id = Column(Integer, primary_key=True)
    status = Column(String)
    __gateforge_archive_state__ = {"status": "archived"}
    __gateforge_delete_semantics__ = "archive"


class HardSessions(Base):
    """Proven hard delete."""

    __tablename__ = "hard_sessions"
    id = Column(Integer, primary_key=True)
    __gateforge_delete_semantics__ = "hard"


class ReadOnlyLedger(Base):
    """Read-only declaration: lifecycle assertions, not suppressions."""

    __tablename__ = "read_only_ledger"
    __gateforge_read_only__ = True
    id = Column(Integer, primary_key=True)


class CandidateOnly(Base):
    """A soft-delete candidate column with NO declaration: fact only."""

    __tablename__ = "candidate_only"
    id = Column(Integer, primary_key=True)
    deleted_at = Column(String)


class ComputedArchive(Base):
    """Non-literal archive declaration: typed unresolved, never guessed."""

    __tablename__ = "computed_archive"
    id = Column(Integer, primary_key=True)
    __gateforge_archive_state__ = derive_archived_fields()
