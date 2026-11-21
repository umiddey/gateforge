from sqlalchemy import insert

from models import LocalSharedRow


def shared_task(fn):
    return fn


@shared_task
def local_job(session):
    session.execute(insert(LocalSharedRow).values(id=1))
