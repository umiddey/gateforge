"""Plane-config fixture: per-tenant models nested one directory DEEPER
(``planes/erp/``) than ``planes/admin_models.py`` — the glob-depth tests
target this file (``planes/**`` matches it, ``planes/*/*.py`` does too,
``planes/*.py`` does not).
"""

from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class ErpBase(DeclarativeBase):
    """Per-tenant declarative base; never materializes."""

    pass


class ErpClient(ErpBase):
    """Per-tenant client row (table ``planes_erp_clients``; class name
    ``ErpClient`` is the tables-rule class-simple-name evidence)."""

    __tablename__ = "planes_erp_clients"
    id = Column(Integer, primary_key=True)
    name = Column(String)
