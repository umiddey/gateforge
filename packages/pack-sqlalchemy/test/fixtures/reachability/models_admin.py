from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

AdminBase = declarative_base()


class DupRowAdmin(AdminBase):
    __tablename__ = "dup_rows"
    id = Column(Integer, primary_key=True)
