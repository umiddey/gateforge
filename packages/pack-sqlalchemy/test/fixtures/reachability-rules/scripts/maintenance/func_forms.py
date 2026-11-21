from sqlalchemy import delete, update

from models import DelRow, LocalRow, NestedMainRow, UpdRow


def insert(model):
    return model


def nested():
    if __name__ == "__main__":
        insert(NestedMainRow)


if __name__ == "__main__":
    update(UpdRow)
    delete(DelRow)
    insert(LocalRow)
