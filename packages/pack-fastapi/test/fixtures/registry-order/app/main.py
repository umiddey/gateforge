"""Fixture: app module that registers every router through the registry function."""

from fastapi import FastAPI

from app.ops import ops_router
from app.router_registry import register_all_routers

app = FastAPI()

register_all_routers(app)

app.include_router(ops_router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok"}
