from mylib import delete, update

from models import DelFakeRow, UpdFakeRow


if __name__ == "__main__":
    update(UpdFakeRow)
    delete(DelFakeRow)
