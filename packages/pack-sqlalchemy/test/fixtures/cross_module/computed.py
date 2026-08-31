"""Cross-module inheritance through a computed base name: the chain
carries no literal tablename anywhere, so resolution must fail typed —
never a guess, never a silent drop (GF-21 mechanic).
"""

from sqlalchemy import Column, Integer
from sqlalchemy.orm import DeclarativeBase, declared_attr


class Base(DeclarativeBase):
    pass


class ComputedBase(Base):
    """Base whose tablename is a computed name."""

    @declared_attr
    def __tablename__(cls):
        return "computed_" + cls.__name__.lower()

    id = Column(Integer, primary_key=True)