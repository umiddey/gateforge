"""Fixture: audit router included inside a try statement."""

from fastapi import APIRouter

audit_router = APIRouter(prefix="/audit")


@audit_router.post("/log")
def write_log():
    return {"logged": True}
