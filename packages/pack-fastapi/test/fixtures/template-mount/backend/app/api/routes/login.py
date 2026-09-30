from fastapi import APIRouter

router = APIRouter(tags=["login"])


@router.post("/login/access-token")
def login_access_token() -> dict[str, str]:
    """The mount target the template reaches through ``login.router``."""
    return {"access_token": "redacted"}
