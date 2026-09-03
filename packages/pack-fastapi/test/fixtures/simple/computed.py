"""Fixture: computed constructs that must produce typed unresolved entries."""

from fastapi import APIRouter

API_PREFIX = "/computed"

dynamic_router = APIRouter(prefix=API_PREFIX)


@dynamic_router.get("/x")
def x():
    return {}


@dynamic_router.get(f"/y/{'segment'}")
def y():
    return {}
