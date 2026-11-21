from sqlalchemy import insert

import app
from models import ServeForeverRow


if __name__ == "__main__":
    session = None
    session.execute(insert(ServeForeverRow).values(id=1))
    app.serve_forever()
