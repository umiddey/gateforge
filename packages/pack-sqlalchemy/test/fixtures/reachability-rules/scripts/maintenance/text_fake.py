from mylib import text

from models import FakeTextRow


if __name__ == "__main__":
    text("INSERT INTO fake_text_rows (id) VALUES (1)")
