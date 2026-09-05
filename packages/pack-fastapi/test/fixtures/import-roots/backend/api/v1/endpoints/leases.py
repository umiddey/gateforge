"""Fixture: leases endpoint module (`from api.v1.endpoints import leases`)."""

from fastapi import APIRouter

router = APIRouter(prefix="/leases")


@router.post("")
def create_lease():
    return {"ok": True}
