"""Fixture: nested aggregation — api_router includes leases under its own prefix.

The registry mounts ``api_router`` at ``/api/v1`` while ALSO mounting
``leases.router`` directly: one router, two mounts, two contracts.
"""

from fastapi import APIRouter

from api.v1.endpoints import leases

api_router = APIRouter()

api_router.include_router(leases.router, prefix="/leasing")
