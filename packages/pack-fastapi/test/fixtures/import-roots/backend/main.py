"""Fixture: central router registry with import-root-resolved absolute imports.

Mirrors the real dogfood shape (``backend/router_registry.py``): every
router is registered HERE via absolute imports rooted at the configured
import root (``import-roots/backend``), not via file-relative imports.
Without the import-root config these includes cannot resolve; with it the
effective paths carry their real ``/api/v1`` prefixes.

- ``from api.v1.endpoints import leases`` + ``leases.router``: submodule
  import binding.
- ``from api.v1 import activities`` + ``activities.router``: module-import
  attribute chain (the imported name IS the module).
- ``from api.v1 import endpoints`` + ``endpoints.health.router``: deep
  attribute chain through an intermediate package.
- ``api_router``: nested composition (a registry-level router that itself
  includes ``leases.router`` under a second prefix — repeated mount).
"""

from fastapi import FastAPI

from api.v1 import activities, endpoints
from api.v1.endpoints import leases
from api.v1.routers import api_router

app = FastAPI()

app.include_router(activities.router, prefix="/api/v1")
app.include_router(leases.router, prefix="/api/v1")
app.include_router(endpoints.health.router, prefix="/api/v1")
app.include_router(api_router, prefix="/api/v1")
