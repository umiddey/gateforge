from mylib_tasks import shared_task
from sqlalchemy import insert

from models import ForeignSharedRow


@shared_task
def foreign_job(session):
    session.execute(insert(ForeignSharedRow).values(id=1))
