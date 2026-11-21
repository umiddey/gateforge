import uvicorn
from sqlalchemy import insert
from sqlalchemy.orm import Session

from app.models import OrphanRow


if __name__ == "__main__":
    session = Session()
    session.execute(insert(OrphanRow).values(id=2))
    uvicorn.run("app.routes:router")
