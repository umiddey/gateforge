from celery_app import app
from locks import ClassDecorator, guarded, partial_factory, plain, two_returns, unreturned


@app.task
@guarded(lease=5)
def guarded_task():
    pass


@app.task
@plain
def plain_task():
    pass


@app.task
@partial_factory(1)
def partial_task():
    pass


@app.task
@two_returns
def branch_task():
    pass


@app.task
@unreturned
def unreturned_task():
    pass


@app.task
@ClassDecorator()
def class_task():
    pass
