"""Plane-config fixture: control-plane models under ``planes/`` (the
``.gateforge/planes.json`` path-rule tests target this file; the nested
``planes/erp/`` sibling pins ``**``/``*`` glob depth semantics).
"""

from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class AdminBase(DeclarativeBase):
    """Control-plane declarative base; never materializes."""

    pass


class AdminUser(AdminBase):
    """Control-plane user row (table ``planes_admin_users``)."""

    __tablename__ = "planes_admin_users"
    id = Column(Integer, primary_key=True)
    login = Column(String)
