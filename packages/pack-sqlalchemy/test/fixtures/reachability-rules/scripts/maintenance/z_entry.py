from sqlalchemy import insert

from models import OrderRow


def write_z(session):
    session.execute(insert(OrderRow).values(id=2))


if __name__ == "__main__":
    write_z(None)
