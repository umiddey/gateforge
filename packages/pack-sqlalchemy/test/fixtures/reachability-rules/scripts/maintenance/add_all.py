from models import AddAllNegRow, AddAllRow


def write_all(session):
    session.add_all([AddAllRow(id=1)])


def write_neg(session):
    rows = [AddAllNegRow(id=1)]
    session.add_all(rows)


if __name__ == "__main__":
    write_all(None)
    write_neg(None)
