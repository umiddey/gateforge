"""Closure shadow (phase 2, detector precision): the simple-name collision.

This file deliberately DEFINES ``WebhookEvent`` as a Pydantic-style
schema (denylisted ``pydantic`` provenance) while `shadow_models.py`
defines a GENUINE ``class WebhookEvent(Base)`` model with the same
simple name. The global model-name closure matches by simple name only,
so without the local-definition veto the schema classes here — and every
subclass beneath them — silently inherit candidacy from the remote
namesake (this exact collision produced blocking entries in a real
dogfood). Under the precise predicate this file emits NOTHING: zero
symbols, zero tables, zero unresolved entries.
"""

from pydantic import BaseModel


class WebhookEvent(BaseModel):
    """Base schema for webhook payloads: NEVER a table."""

    event: str
    timestamp: str


class TaskStatusUpdateWebhook(WebhookEvent):
    """Subclass of the local schema: must NOT inherit model candidacy."""

    task_id: str
    status: str


class InvoiceSentWebhook(WebhookEvent):
    """Second subclass of the local schema: also never a table."""

    invoice_id: str
