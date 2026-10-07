"""Fixture: ops router mounted directly by the app module, after the call."""

from fastapi import APIRouter

ops_router = APIRouter(prefix="/ops")


@ops_router.get("/status")
def status():
    return {"status": "ok"}
