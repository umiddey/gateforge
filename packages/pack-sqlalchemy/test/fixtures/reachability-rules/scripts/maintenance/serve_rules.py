from mylib_server import serve
from sqlalchemy import insert

from models import ServeRow


if __name__ == "__main__":
    session = None
    session.execute(insert(ServeRow).values(id=1))
    serve()
