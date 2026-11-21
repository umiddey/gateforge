from sqlalchemy import insert

from app.models import OrphanRow


def test_seed(session=None):
    session.execute(insert(OrphanRow).values(id=1))


if __name__ == "__main__":
    test_seed(None)
