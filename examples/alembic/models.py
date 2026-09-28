"""SQLAlchemy models for the Alembic example application."""

from __future__ import annotations

from sqlalchemy import Column, ForeignKey, Integer, String, Text
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class Invoice(Base):
    """Invoice business model."""

    __tablename__ = "invoices"

    id = Column(String, primary_key=True)
    client_name = Column(String, nullable=False)
    total_amount = Column(Integer, nullable=False)
    status = Column(String, nullable=False, default="draft")
    notes = Column(Text, nullable=True)

    items = relationship("InvoiceItem", back_populates="invoice", cascade="all, delete-orphan")


class InvoiceItem(Base):
    """Line item belonging to an invoice."""

    __tablename__ = "invoice_items"

    id = Column(String, primary_key=True)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=False)
    description = Column(String, nullable=False)
    quantity = Column(Integer, nullable=False, default=1)
    unit_price = Column(Integer, nullable=False)

    invoice = relationship("Invoice", back_populates="items")
