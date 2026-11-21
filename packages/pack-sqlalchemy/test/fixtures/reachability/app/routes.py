from fastapi import APIRouter
from sqlalchemy import insert

from app.models import RouteNote

router = APIRouter()


@router.post("/notes")
def create_note(session=None):
    session.execute(insert(RouteNote).values(id=1))
