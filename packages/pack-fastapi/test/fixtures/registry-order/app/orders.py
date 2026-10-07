"""Fixture: orders router mounted through the registry function."""

from fastapi import APIRouter

orders_router = APIRouter(prefix="/orders")


@orders_router.get("")
def list_orders():
    return {"orders": []}


@orders_router.get("/{order_id}")
def get_order(order_id: int):
    return {"id": order_id}
