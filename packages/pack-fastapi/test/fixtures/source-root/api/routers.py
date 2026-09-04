from fastapi import APIRouter

router = APIRouter(prefix="/accounts")

@router.get("")
def list_accounts():
    return []
