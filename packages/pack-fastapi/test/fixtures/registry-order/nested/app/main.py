"""Fixture: app module calling the registry function once (nested-include variant)."""

from fastapi import FastAPI

from app.router_registry import register_all_routers

app = FastAPI()

register_all_routers(app)
