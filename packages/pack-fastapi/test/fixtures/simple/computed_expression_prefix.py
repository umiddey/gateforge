"""Fixture: prefixes that are genuinely computed and must stay blocked.

`simple/computed.py` holds the other half of this pair: a prefix written as
a module-level string CONSTANT, which is provable and therefore folded. The
prefixes here cannot be computed from the source (an f-string and an
attribute read), so every route behind them is a typed
``FASTAPI_PREFIX_UNRESOLVED`` outcome and no path is invented.
"""

from fastapi import APIRouter

VERSION = "v1"

fstring_router = APIRouter(prefix=f"/api/{VERSION}")
attribute_router = APIRouter(prefix=settings.API_PREFIX)


@fstring_router.get("/orders/{order_id}")
def get_order(order_id: str):
    return {"id": order_id}


@attribute_router.get("/shipments/{shipment_id}")
def get_shipment(shipment_id: str):
    return {"id": shipment_id}