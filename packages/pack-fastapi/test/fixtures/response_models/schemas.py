"""Fixture: response models whose wire names the pack must prove.

Covers every shape the field extraction has an opinion about: a plain
model, a `Field(alias=...)` declaration, a model inheriting a model from
ANOTHER scanned module, a model whose wire names an alias generator
computes (never provable — it must stay silent), a model with an
unresolvable base, and shapes that are not models at all.
"""

from typing import ClassVar, Optional

from pydantic import BaseModel, ConfigDict, Field


class MoneyOut(BaseModel):
    amount_cents: int
    currency: str = "usd"


class InvoiceOut(MoneyOut):
    id: int
    due_date: str = Field(alias="invoiceDueDate")
    internal_note: ClassVar[str] = "not a response field"


class GeneratedOut(BaseModel):
    model_config = ConfigDict(alias_generator=str.upper)

    id: int


class ConfigOut(BaseModel):
    class Config:
        alias_generator = str.upper

    id: int


class ForeignOut(SomeUnscannedBase):
    id: int
