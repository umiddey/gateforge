"""Fixture: health endpoint module (deep chain target `endpoints.health.router`)."""

from fastapi import APIRouter

router = APIRouter(prefix="/health")


@router.get("/live")
def live():
    return {"live": True}
