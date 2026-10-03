"""002_rename_customer

Revision ID: 002_rename_customer
Revises: 001_initial

"""
from alembic import op


revision: str = '002_rename_customer'
down_revision: str = '001_initial'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column('invoices', 'customer_name', new_column_name='client_name')


def downgrade() -> None:
    op.alter_column('invoices', 'client_name', new_column_name='customer_name')
