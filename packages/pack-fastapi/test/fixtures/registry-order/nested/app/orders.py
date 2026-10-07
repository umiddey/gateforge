"""Fixture: orders router included inside a for statement."""

from fastapi import APIRouter

orders_router = APIRouter(prefix="/orders")


@orders_router.get("")
def list_orders():
    return {"orders": []}
