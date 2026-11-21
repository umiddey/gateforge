from sqlalchemy import insert

from models import ShadowTaskRow


class Celery:
    def task(self, f):
        return f


app = Celery()


@app.task
def sync_shadow():
    insert(ShadowTaskRow)
