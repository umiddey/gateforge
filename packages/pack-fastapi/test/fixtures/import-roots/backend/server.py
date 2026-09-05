"""Fixture: module-level call sites mounting routers through registry functions.

- ``register_feature_routers(fastapi_app)``: the argument resolves to the
  module-level ``FastAPI()`` instance — the dogfood shape that must
  propagate its parameter-mediated includes onto the instance.
- ``register_chained(fastapi_app)``: same, one helper hop deeper.
- ``fastapi_app.include_router(ops_router, prefix="/api/v1")``:
  ``from ops import router`` binds through the package ``__init__.py``
  re-export (there is no ``ops/router.py``).
- ``register_feature_routers(never_bound)``: unresolvable argument — a
  typed unresolved entry at this exact call site, and NO emission (the
  reports router is provably included, its source carries prefixes, so
  no prefix-less standalone paths are fabricated).
"""

from fastapi import FastAPI

from ops import router as ops_router
from registry import register_chained, register_feature_routers

fastapi_app = FastAPI()

register_feature_routers(fastapi_app)
register_chained(fastapi_app)
fastapi_app.include_router(ops_router, prefix="/api/v1")

register_feature_routers(never_bound)
