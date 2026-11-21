from alembic import op
from sqlalchemy import text


def main(session, sql_var):
    session.execute(text("INSERT INTO text_insert_rows (id) VALUES (1)"))
    session.execute(text("UPDATE text_update_rows SET id = 2"))
    session.execute(text("DELETE FROM text_delete_rows WHERE id = 1"))
    session.execute(text("SELECT id FROM text_select_rows"))
    op.execute(f"INSERT INTO {sql_var} (id) VALUES (1)")
    session.execute(text(sql_var))


if __name__ == "__main__":
    main(None, "dyn_rows")
