from sqlalchemy import insert

from models import ClassRow


if __name__ == "__main__":
    session = None
    session.execute(insert(ClassRow).values(id=1))
