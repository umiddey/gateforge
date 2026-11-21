from sqlalchemy import insert

from app.models import IndirectRow


class Runner:
    def write(self, session):
        session.execute(insert(IndirectRow).values(id=3))


if __name__ == "__main__":
    Runner().write(None)
