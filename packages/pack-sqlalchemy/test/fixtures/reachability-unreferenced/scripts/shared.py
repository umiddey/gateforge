from models import ImportedScriptOnly


def refresh():
    return ImportedScriptOnly.__tablename__


if __name__ == "__main__":
    print(refresh())
