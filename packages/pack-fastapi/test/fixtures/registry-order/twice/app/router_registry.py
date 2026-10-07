"""Fixture: registry function called TWICE by the app module (fail closed)."""

from fastapi import FastAPI

from app.admin import admin_router
from app.items import items_router


def register_all_routers(app: FastAPI) -> None:
    app.include_router(items_router, prefix="/api/v1")
    app.include_router(admin_router, prefix="/api/v1")
