"""Fixture: FastAPI app composing routers with include prefixes.

- ``items`` (the router object, imported directly) is mounted twice
  (``/api/v1`` and ``/api/latest``): one router, two mounts, one contract
  fact per (mount, route, method).
- the alias-declared route from ``app.alias`` must appear under both
  mounts after the alias merge.
"""

from fastapi import FastAPI

from app.routers import items

app = FastAPI()

app.include_router(items, prefix="/api/v1")
app.include_router(items, prefix="/api/latest")
