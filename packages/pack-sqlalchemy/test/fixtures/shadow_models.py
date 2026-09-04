"""Genuine namesake model (phase 2, detector precision).

The OTHER half of the closure-shadow pair: a real SQLAlchemy
``class WebhookEvent(Base)`` sharing its simple name with the Pydantic
schema in `shadow_schemas.py`. Both files scanned together must keep
THIS side a candidate (literal ``__tablename__`` facts are
unconditional) while the schema side stays silent, and the local
subclass ``PaymentReceipt(WebhookEvent)`` must still inherit candidacy
from its LOCAL genuine base — the veto is per-file evidence, not a
global name ban.
"""

from sqlalchemy import Column, Integer

from app.db import Base


class WebhookEvent(Base):
    """Genuine model sharing its simple name with a Pydantic schema."""

    __tablename__ = "shadow_webhook_events"

    id = Column(Integer, primary_key=True)


class PaymentReceipt(WebhookEvent):
    """Inherits candidacy from the LOCAL genuine WebhookEvent."""

    __tablename__ = "shadow_payment_receipts"

    id = Column(Integer, primary_key=True)
    amount = Column(Integer, nullable=False)
