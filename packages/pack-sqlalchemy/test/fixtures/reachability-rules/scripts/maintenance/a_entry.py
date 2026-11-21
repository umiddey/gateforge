from sqlalchemy import insert

from models import OrderRow


def write_order(session):
    session.execute(insert(OrderRow).values(id=1))


if __name__ == "__main__":
    write_order(None)
