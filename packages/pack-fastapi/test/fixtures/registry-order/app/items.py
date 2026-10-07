"""Fixture: items router — a literal route declared before a parameter route."""

from fastapi import APIRouter

items_router = APIRouter(prefix="/items")


@items_router.get("/export")
def export_items():
    return {"items": []}


@items_router.get("/{item_id}")
def get_item(item_id: int):
    return {"id": item_id}
