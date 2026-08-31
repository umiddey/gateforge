"""The example app's accounts model: a single user-facing table named
``accounts`` (the sample classification and plane-mapping docs target
the ``example.accounts`` resource; see the pack README).
"""

from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Account(Base):
    """Example app accounts row; read via GET /api/accounts/:id."""

    __tablename__ = "accounts"
    id = Column(Integer, primary_key=True)
    first_name = Column(String)
    last_name = Column(String)
    status = Column(String)
    created_at = Column(String)
    updated_at = Column(String)