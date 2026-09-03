"""Fixture: router with prefix, api_route methods list, path converter."""

from fastapi import APIRouter

items = APIRouter(prefix="/items")


@items.get("/{item_id}")
async def get_item(item_id: int):
    return {"id": item_id}


@items.api_route("", methods=["GET", "POST"])
async def items_collection():
    return []


@items.delete("/{item_id}")
def delete_item(item_id: int):
    return {"deleted": item_id}
