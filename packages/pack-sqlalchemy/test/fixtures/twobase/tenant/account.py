"""Two-Base fixture: tenant model with ARCHIVE delete declarations."""

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from models_base import Base


class TwobaseAccount(Base):
    __tablename__ = "twobase_accounts"
    __gateforge_delete_semantics__ = "archive"
    __gateforge_archive_state__ = {"status": "archived"}
    id = mapped_column(String(36), primary_key=True)
    name = mapped_column(String(255), nullable=False)
