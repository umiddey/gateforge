"""Fixture: archive router — included ONLY by the never-called register_orphan.

Suppressed from standalone emission (it is the target of a resolvable
include) and provably never mounted (no call site): the honest outcome is
no facts at all — neither prefix-less nor prefixed.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/archive")


@router.get("/items")
def list_archived():
    return []
