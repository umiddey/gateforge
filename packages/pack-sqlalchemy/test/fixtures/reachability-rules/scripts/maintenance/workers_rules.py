from celery import Celery, shared_task
from sqlalchemy import insert

from models import SharedRow, UnboundRow, WorkerCallRow

rules_app = Celery("rules")


class Plain:
    def task(self, fn):
        return fn


unbound = Plain()


@shared_task
def shared_job(session):
    session.execute(insert(SharedRow).values(id=1))


@rules_app.task(name="worker_call")
def call_job(session):
    session.execute(insert(WorkerCallRow).values(id=1))


@unbound.task
def unbound_job(session):
    session.execute(insert(UnboundRow).values(id=1))
