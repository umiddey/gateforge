"""Simple and composite primary-key fixtures (plan phase 3).

Every form the detector must derive an ORDERED identity signal from:

- simple single-column key (``id = Column(Integer, primary_key=True)``)
- composite key via two ``primary_key=True`` columns in written order
- composite key via a literal ``PrimaryKeyConstraint`` (the constraint's
  ordered columns are the authoritative key)
- ``mapped_column`` style key (SQLAlchemy 2.0)
- composite key on a raw ``Table()`` call
- a literal ``ForeignKey`` fact for cross-artifact linkage
- a soft-delete candidate column (attribute fact only, never semantics)
"""

from sqlalchemy import Column, ForeignKey, Integer, MetaData, PrimaryKeyConstraint, String, Table
from sqlalchemy.orm import DeclarativeBase, mapped_column


class Base(DeclarativeBase):
    pass


class SimplePk(Base):
    """Simple single-column key."""

    __tablename__ = "simple_pks"
    id = Column(Integer, primary_key=True)


class CompositePk(Base):
    """Composite key in column written order: (tenant_id, member_no)."""

    __tablename__ = "composite_pks"
    tenant_id = Column(Integer, primary_key=True)
    member_no = Column(Integer, primary_key=True)
    label = Column(String)


class ConstraintPk(Base):
    """Composite key declared by a literal PrimaryKeyConstraint."""

    __tablename__ = "constraint_pks"
    __table_args__ = (PrimaryKeyConstraint("region", "banner"),)
    region = Column(Integer)
    banner = Column(String)


class MappedPk(Base):
    """SQLAlchemy 2.0 mapped_column style key."""

    __tablename__ = "mapped_pks"
    id: int = mapped_column(Integer, primary_key=True)


class FKTable(Base):
    """Literal ForeignKey fact + a soft-delete candidate column."""

    __tablename__ = "fk_tables"
    id = Column(Integer, primary_key=True)
    parent_id = Column(Integer, ForeignKey("simple_pks.id"))
    deleted_at = Column(String)


orders = Table(
    "orders",
    MetaData(),
    Column("shop_id", Integer, primary_key=True),
    Column("order_no", Integer, primary_key=True),
    Column("item", String),
)
