"""Fixture: ops router re-exported by the package __init__ (no ops/router.py)."""

from fastapi import APIRouter

router = APIRouter(prefix="/ops")


@router.get("/status")
def status():
    return {"up": True}
