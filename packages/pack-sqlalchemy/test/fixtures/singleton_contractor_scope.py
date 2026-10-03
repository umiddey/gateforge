"""A tenant-plane table whose scope column is NOT named like a tenant.

The real incident's ledger table is scoped by ``contractor_id``: unique
(contractor_id, ledger_id, kind) admits one row per contractor, so a
create is provable only on a fresh contractor. The fixed
``TENANT_SCOPE_COLUMNS`` list cannot recognize ``contractor_id``, so the
owner has to be able to DECLARE the scope column name; the default list
must stay exactly as it is for every other repository.

Facts emitted here are ADDITIVE attributes (``uniqueConstraints``); the
per-tenant-singleton tag is minted in the TypeScript wrapper.
"""
from sqlalchemy import Column, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class ContractorLedgerEntry(Base):
    """Unique (contractor_id, ledger_id, kind): one row per contractor."""

    __tablename__ = "contractor_ledger_entries"
    __table_args__ = (
        UniqueConstraint("contractor_id", "ledger_id", "kind", name="uq_contractor_ledger_kind"),
    )

    id = Column(Integer, primary_key=True)
    contractor_id = Column(String(32), ForeignKey("contractors.id"), nullable=False)
    ledger_id = Column(String(32), nullable=False)
    kind = Column(String(16), nullable=False)


class ContractorLedger(Base):
    """Unique on a non-scope column: two contractors may both create one."""

    __tablename__ = "contractor_ledgers"
    __table_args__ = (UniqueConstraint("code", name="uq_contractor_ledger_code"),)

    id = Column(Integer, primary_key=True)
    contractor_id = Column(String(32), ForeignKey("contractors.id"), nullable=False)
    code = Column(String(32), nullable=False)