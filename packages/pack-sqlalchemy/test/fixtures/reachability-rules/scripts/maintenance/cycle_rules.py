from sqlalchemy import insert

from models import CycleRow


def ping(n):
    if n:
        pong(n - 1)


def pong(n, session=None):
    ping(n)
    session.execute(insert(CycleRow).values(id=1))


if __name__ == "__main__":
    ping(3)
