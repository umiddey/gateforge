from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import LedgerEntry

engine = create_engine("sqlite://")


def main():
    with Session(engine) as session:
        session.add(LedgerEntry(id=1))


if __name__ == "__main__":
    main()
