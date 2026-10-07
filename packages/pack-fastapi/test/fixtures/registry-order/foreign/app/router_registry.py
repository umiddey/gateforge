"""Fixture: registry function for the foreign-module variant."""

from fastapi import FastAPI

from app.items import items_router


def register_all_routers(app: FastAPI) -> None:
    app.include_router(items_router, prefix="/api/v1")
