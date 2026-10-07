"""Fixture: the registry function is called inside a module-level if (fail closed)."""

import os

from fastapi import FastAPI

from app.router_registry import register_all_routers

app = FastAPI()

if os.environ.get("REGISTER_ROUTERS", "1") != "0":
    register_all_routers(app)
