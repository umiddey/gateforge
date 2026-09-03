"""Fixture: items router mounted twice + alias-declared routes."""

from fastapi import APIRouter

items = APIRouter(prefix="/items")


@items.get("/{item_id}")
async def get_item(item_id: int):
    return {"id": item_id}


@items.api_route("", methods=["GET", "POST"])
async def items_collection():
    return []
