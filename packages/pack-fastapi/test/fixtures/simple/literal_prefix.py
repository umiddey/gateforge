"""Fixture: the same mount as computed.py, with a provable literal prefix."""

from fastapi import APIRouter

literal_router = APIRouter(prefix="/computed")


@literal_router.get("/x")
def x():
    return {}
