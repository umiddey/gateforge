"""Fixture: a DIFFERENT module calls the registry function with the app (fail closed)."""

from app.main import app
from app.router_registry import register_all_routers

register_all_routers(app)
