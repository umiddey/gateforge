"""Fixture: SAME module path (api.v1.activities) under a second import root.

With both roots configured, ``from api.v1 import activities`` matches this
file AND ``import-roots/backend/api/v1/activities.py`` — the include must
stay typed-unresolved (ambiguous), never guessed.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/activities")


@router.get("/{activity_id}")
def admin_get_activity(activity_id: int):
    return {"id": activity_id}
