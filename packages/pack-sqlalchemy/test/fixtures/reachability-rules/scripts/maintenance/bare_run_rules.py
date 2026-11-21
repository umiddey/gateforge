from mylib import run
from sqlalchemy import insert

from models import BareRunRow


if __name__ == "__main__":
    session = None
    session.execute(insert(BareRunRow).values(id=1))
    run()
