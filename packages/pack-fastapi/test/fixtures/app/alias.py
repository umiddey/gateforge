"""Fixture: routes declared through an import-aliased router name.

``items_router`` and ``items`` are the same router object; the route
declared here must join the defining router's route set (alias merge).
"""

from app.routers import items as items_router


@items_router.get("/aliased/{slug}")
def aliased_route(slug: str):
    return {"slug": slug}
