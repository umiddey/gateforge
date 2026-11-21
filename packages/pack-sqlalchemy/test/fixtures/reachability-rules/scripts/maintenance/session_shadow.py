from models import ShadowRow


class Session:
    def __init__(self, engine):
        self.engine = engine

    def add(self, row):
        return row


def write(engine):
    Session(engine).add(ShadowRow(id=1))


if __name__ == "__main__":
    write(None)
