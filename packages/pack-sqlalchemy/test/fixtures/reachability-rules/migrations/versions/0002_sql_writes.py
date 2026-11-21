from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade():
    op.execute("INSERT INTO sql_insert_rows (id) VALUES (1)")
    op.execute("UPDATE sql_update_rows SET id = 2")
    op.execute("DELETE FROM sql_delete_rows WHERE id = 1")
    op.execute("   insert into lower_rows (id) values (1)")
    op.execute('INSERT INTO "public"."quoted_rows" (id) VALUES (1)')


def downgrade():
    pass
