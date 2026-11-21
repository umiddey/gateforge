from sqlalchemy import delete, insert, table, update

from models import ClassDup, TableAttrRow, TableDeleteRow, TableInsertRow, TableUpdateRow


def main(session):
    session.execute(insert(TableInsertRow.__table__).values(id=1))
    session.execute(update(TableUpdateRow.__table__).values(id=1))
    session.execute(delete(TableDeleteRow.__table__))
    session.execute(insert(ClassDup))
    session.execute(insert(table("bare_rows")).values(id=1))
    session.execute(insert(TableAttrRow.__table__).values(id=1))


if __name__ == "__main__":
    main(None)
