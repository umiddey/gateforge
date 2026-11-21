from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

TenantBase = declarative_base()


class DupRowTenant(TenantBase):
    __tablename__ = "dup_rows"
    id = Column(Integer, primary_key=True)
