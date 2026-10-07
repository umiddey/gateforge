"""Fixture: registry function mixing a top-level include with loop/try/with ones."""

import contextlib

from fastapi import FastAPI

from app.audit import audit_router
from app.items import items_router
from app.orders import orders_router
from app.sandbox import sandbox_router


def register_all_routers(app: FastAPI) -> None:
    app.include_router(items_router, prefix="/api/v1")
    for _attempt in range(2):
        app.include_router(orders_router, prefix="/api/v1")
    try:
        app.include_router(audit_router)
    except Exception:  # noqa: BLE001
        pass
    with contextlib.suppress(ValueError):
        app.include_router(sandbox_router)
