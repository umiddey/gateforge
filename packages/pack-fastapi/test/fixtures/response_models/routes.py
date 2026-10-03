"""Fixture: routes whose effective response model is provable or not."""

from typing import Optional

from fastapi import APIRouter

from response_models.schemas import (
    ConfigOut,
    ForeignOut,
    GeneratedOut,
    InvoiceOut,
    MoneyOut,
)

router = APIRouter()


@router.get("/invoices/{invoice_id}")
def read_invoice(invoice_id: int) -> InvoiceOut:
    return InvoiceOut(id=invoice_id)


@router.get("/invoices")
def list_invoices() -> list[InvoiceOut]:
    return []


@router.post("/invoices", response_model=InvoiceOut)
def create_invoice(payload: dict) -> InvoiceOut:
    return InvoiceOut(id=1)


@router.get("/money")
def read_money() -> MoneyOut:
    return MoneyOut(amount_cents=1)


@router.get("/maybe")
def read_maybe() -> Optional[MoneyOut]:
    return None


@router.get("/generated")
def read_generated() -> GeneratedOut:
    return GeneratedOut(id=1)


@router.get("/configured")
def read_configured() -> ConfigOut:
    return ConfigOut(id=1)


@router.get("/foreign")
def read_foreign() -> ForeignOut:
    return ForeignOut(id=1)


@router.get("/opaque")
def read_opaque() -> dict:
    return {}


@router.get("/union")
def read_union() -> "MoneyOut | GeneratedOut":
    return MoneyOut(amount_cents=1)


@router.get("/unannotated")
def read_unannotated():
    return {"id": 1}
