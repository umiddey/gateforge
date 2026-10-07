"""Fixture: admin router for the called-twice variant."""

from fastapi import APIRouter

admin_router = APIRouter(prefix="/admin")


@admin_router.post("/reset")
def reset_state():
    return {"status": "reset"}
