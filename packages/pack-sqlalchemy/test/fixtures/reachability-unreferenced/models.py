from sqlalchemy import Column, Integer, Table
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class OrphanLedger(Base):
    __tablename__ = "orphan_ledger"
    id = Column(Integer, primary_key=True)


class UsedThing(Base):
    __tablename__ = "used_things"
    id = Column(Integer, primary_key=True)


class NamedInText(Base):
    __tablename__ = "named_in_text"
    id = Column(Integer, primary_key=True)


class ScriptOnly(Base):
    __tablename__ = "script_only"
    id = Column(Integer, primary_key=True)


class ImportedScriptOnly(Base):
    __tablename__ = "imported_script_only"
    id = Column(Integer, primary_key=True)


class JsNamed(Base):
    __tablename__ = "js_named"
    id = Column(Integer, primary_key=True)


loose_rows = Table(
    "loose_rows",
    Base.metadata,
    Column("id", Integer, primary_key=True),
)
