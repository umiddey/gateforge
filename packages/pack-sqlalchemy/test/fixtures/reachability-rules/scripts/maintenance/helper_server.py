import uvicorn
from sqlalchemy import insert

from models import HelperServerRow


def helper(session):
    session.execute(insert(HelperServerRow).values(id=1))
    uvicorn.run("app:app")


if __name__ == "__main__":
    helper(None)
