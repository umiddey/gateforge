"""Fixture: items router for the foreign-module variant."""

from fastapi import APIRouter

items_router = APIRouter(prefix="/items")


@items_router.get("/export")
def export_items():
    return {"items": []}
