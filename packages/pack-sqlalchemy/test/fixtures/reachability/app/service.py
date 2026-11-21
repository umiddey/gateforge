from sqlalchemy import insert

from app.models import ExportLog, OrphanRow


def record_export(session=None):
    session.execute(insert(ExportLog).values(id=1))


def unused_writer(session):
    session.execute(insert(OrphanRow).values(id=2))
