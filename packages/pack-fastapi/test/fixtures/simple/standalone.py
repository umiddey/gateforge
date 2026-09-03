"""Fixture: standalone router never included by any app."""

from fastapi import APIRouter

admin = APIRouter(prefix="/admin")


@admin.get("/stats")
def stats():
    return {"up": True}
