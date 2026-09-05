"""Fixture: registry functions — include_router on a FUNCTION PARAMETER.

Mirrors the dogfood's ``register_all_routers(app)`` shape: the include
chain cannot traverse the parameter without interprocedural propagation,
so without it these routers are suppressed (they ARE included) yet emit
nothing. ``register_chained`` adds one helper hop (bounded chaining);
``register_orphan`` is never called, so its router provably never mounts
(suppressed from standalone emission, no facts, no noise — closed world).
"""

from api.v1.endpoints import archive, reports


def register_feature_routers(app):
    app.include_router(reports.router, prefix="/api/v1")


def _register_core(router):
    router.include_router(reports.router, prefix="/api/v1/core")


def register_chained(app):
    _register_core(app)


def register_orphan(app):
    app.include_router(archive.router, prefix="/api/v1/archive")
