"""Fixture: the registry function the app module calls exactly once.

Straight-line includes expand in place; the environment-conditional
include executes at call time, so its routes stay unattributable.
"""

import logging
import os

from fastapi import FastAPI

from app.admin import admin_router
from app.items import items_router
from app.orders import orders_router
from app.sandbox import sandbox_router

logger = logging.getLogger(__name__)


def register_all_routers(app: FastAPI) -> None:
    app.include_router(items_router, prefix="/api/v1")
    app.include_router(orders_router, prefix="/api/v1")
    if os.environ.get("ENV", "dev") != "production":
        app.include_router(sandbox_router)
    else:
        logger.warning("sandbox router disabled in production")
    app.include_router(admin_router)
