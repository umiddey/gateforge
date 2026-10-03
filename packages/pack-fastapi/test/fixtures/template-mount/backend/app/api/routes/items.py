from fastapi import APIRouter

router = APIRouter(tags=["items"])


@router.get("/items/")
def read_items() -> list[str]:
    """The mount target the template reaches through ``items.router``."""
    return []
