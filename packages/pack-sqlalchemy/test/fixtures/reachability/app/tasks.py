from app.service import record_export
from app.worker import celery_app


@celery_app.task
def nightly_export():
    record_export()
