from celery import Celery
from sqlalchemy import insert

from models import ShadowRealTaskRow

app = Celery("shadow")


@app.task
def sync_real():
    insert(ShadowRealTaskRow)
