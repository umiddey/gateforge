"""Function-local class definitions shadowing a module-level name (GF-01).

- module-level class Row
- identical class name Row local to two functions, each declaring a
  different table name
- identical class name Row local to two functions declaring the SAME
  table name (distinct resources; duplicate-table-name finding)
"""

from sqlalchemy import Column, Integer
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Row(Base):
    """Module-level Row."""

    __tablename__ = "rows_module"
    id = Column(Integer, primary_key=True)


def build_queue_rows():
    """Function-local Row #1."""

    class Row(Base):
        __tablename__ = "rows_queue_a"
        id = Column(Integer, primary_key=True)

    return Row


def build_worker_rows():
    """Function-local Row #2, same class name, different table."""

    class Row(Base):
        __tablename__ = "rows_worker_b"
        id = Column(Integer, primary_key=True)

    return Row


def build_tenant_rows():
    """Function-local Row #3, same class name, same table as worker_b."""

    class Row(Base):
        __tablename__ = "rows_worker_b"
        id = Column(Integer, primary_key=True)

    return Row