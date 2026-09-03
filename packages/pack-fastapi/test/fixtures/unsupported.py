"""Fixture: decorator verb outside the supported method set."""

from fastapi import APIRouter

tracer = APIRouter(prefix="/traces")


@tracer.trace("/emit")
def emit():
    return {}
