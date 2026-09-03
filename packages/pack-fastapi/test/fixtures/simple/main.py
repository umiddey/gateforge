"""Fixture: plain FastAPI app routes — sync + async handlers, schemas."""

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class AccountOut(BaseModel):
    id: int


class AccountIn(BaseModel):
    name: str


@app.get("/api/accounts")
def list_accounts() -> list[AccountOut]:
    return []


@app.post("/api/accounts", response_model=AccountOut, tags=["accounts"], operation_id="create-account")
async def create_account(payload: AccountIn) -> AccountOut:
    return AccountOut(id=1)


@app.get("/api/accounts/{account_id}")
async def get_account(account_id: int) -> AccountOut:
    return AccountOut(id=account_id)


@app.get("/api/health/ready")
def readiness() -> dict:
    return {"ready": True}
