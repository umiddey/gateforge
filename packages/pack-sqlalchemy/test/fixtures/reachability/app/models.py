from sqlalchemy import Column, Integer, String, Table
from sqlalchemy.orm import declarative_base

Base = declarative_base()

seed_codes = Table(
    "seed_codes",
    Base.metadata,
    Column("code", String, primary_key=True),
)


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    id = Column(Integer, primary_key=True)


class ExportLog(Base):
    __tablename__ = "export_logs"
    id = Column(Integer, primary_key=True)


class OrphanRow(Base):
    __tablename__ = "orphan_rows"
    id = Column(Integer, primary_key=True)


class RouteNote(Base):
    __tablename__ = "route_notes"
    id = Column(Integer, primary_key=True)


class IndirectRow(Base):
    __tablename__ = "indirect_rows"
    id = Column(Integer, primary_key=True)
