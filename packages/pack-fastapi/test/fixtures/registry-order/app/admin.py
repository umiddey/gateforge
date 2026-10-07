"""Fixture: admin router mounted last by the registry function."""

from fastapi import APIRouter

admin_router = APIRouter(prefix="/admin")


@admin_router.post("/reset")
def reset_state():
    return {"status": "reset"}
