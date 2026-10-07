"""Fixture: sandbox router included inside a with statement."""

from fastapi import APIRouter

sandbox_router = APIRouter(prefix="/sandbox")


@sandbox_router.get("/echo")
def echo():
    return {"echo": True}
