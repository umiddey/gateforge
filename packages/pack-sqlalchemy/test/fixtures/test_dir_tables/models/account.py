"""The REAL model: the business table the gate must classify.

``__tablename__`` is deliberately the same name a pytest fixture module
re-declares (``tests/test_account.py``). A fixture copy is not business
surface and must not enter the resource graph.
"""
from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Local declarative base."""


class Account(Base):
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True)
    name = Column(String(64))