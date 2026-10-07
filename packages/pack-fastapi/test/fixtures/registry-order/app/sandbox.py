"""Fixture: sandbox router mounted only by the conditional include."""

from fastapi import APIRouter

sandbox_router = APIRouter(prefix="/sandbox")


@sandbox_router.get("/echo")
def echo():
    return {"echo": True}
