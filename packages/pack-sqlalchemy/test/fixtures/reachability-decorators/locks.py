import functools


def get_conn():
    return None


def acquire(name):
    with get_conn().cursor() as cur:
        cur.execute("INSERT INTO job_locks (id) VALUES (1)")


def mark():
    with get_conn().cursor() as cur:
        cur.execute("INSERT INTO audit_marks (id) VALUES (1)")


def guarded(lease):
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            acquire("job")
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def plain(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        mark()
        return fn(*args, **kwargs)

    return wrapper


def partial_factory(n):
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            with get_conn().cursor() as cur:
                cur.execute("INSERT INTO partial_rows (id) VALUES (1)")
            return fn(*args, **kwargs)

        return wrapper

    return functools.partial(decorator)


def two_returns(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with get_conn().cursor() as cur:
            cur.execute("INSERT INTO branch_rows (id) VALUES (1)")
        return fn(*args, **kwargs)

    if fn is None:
        return wrapper
    return wrapper


def unreturned(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with get_conn().cursor() as cur:
            cur.execute("INSERT INTO unreturned_rows (id) VALUES (1)")
        return fn(*args, **kwargs)

    return fn


class ClassDecorator:
    def __call__(self, fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            with get_conn().cursor() as cur:
                cur.execute("INSERT INTO class_rows (id) VALUES (1)")
            return fn(*args, **kwargs)

        return wrapper
