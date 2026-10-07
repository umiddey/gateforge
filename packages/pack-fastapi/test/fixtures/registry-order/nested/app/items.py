"""Fixture: items router for the loop/try/with variant."""

from fastapi import APIRouter

items_router = APIRouter(prefix="/items")


@items_router.get("/export")
def export_items():
    return {"items": []}


@items_router.get("/{item_id}")
def get_item(item_id: int):
    return {"id": item_id}
