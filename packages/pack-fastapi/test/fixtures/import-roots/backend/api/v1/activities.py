"""Fixture: activities router reached via `from api.v1 import activities`."""

from fastapi import APIRouter

router = APIRouter(prefix="/activities")


@router.get("/{activity_id}")
def get_activity(activity_id: int):
    return {"id": activity_id}
