"""Two-Base fixture: master model with NO delete declarations.

This is the recorded consumer gap shape: the table is real (literal
``__tablename__``, literal primary key) but the tree never declared its
delete semantics, so classification fail-closes until the owner marks it.
"""

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from base import Base


class TwobaseClientInstance(Base):
    __tablename__ = "twobase_client_instances"
    id = mapped_column(String(36), primary_key=True)
    name = mapped_column(String(255), nullable=False)
