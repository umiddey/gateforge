"""Fixture: reports router mounted TWICE through registry functions.

No prefix of its own: every effective prefix comes from the
``include_router(prefix=...)`` calls inside the registry functions, so
any emission without the interprocedural propagation would be prefix-less
(the dogfood failure this fixture pins).
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/ping")
def ping():
    return {"ping": True}


@router.get("/")
def list_reports():
    return []
