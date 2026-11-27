def with_cursor(conn):
    with conn.cursor() as cur:
        cur.execute("""
    INSERT INTO cursor_with_rows (id) VALUES (1)
""")


def assigned_cursor(conn):
    cur = conn.cursor()
    cur.execute("UPDATE cursor_assign_rows SET id = 2")


def param_cursor(cur):
    cur.execute("DELETE FROM cursor_param_rows")


def conn_execute(conn):
    conn.execute("INSERT INTO cursor_conn_rows (id) VALUES (1)")


if __name__ == "__main__":
    with_cursor(None)
    assigned_cursor(None)
    param_cursor(None)
    conn_execute(None)
