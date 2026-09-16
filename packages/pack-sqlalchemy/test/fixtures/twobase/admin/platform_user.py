"""Two-Base fixture: master model with HARD-delete declaration."""

from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from base import Base


class TwobasePlatformUser(Base):
    __tablename__ = "twobase_platform_users"
    __gateforge_delete_semantics__ = "hard"
    id = mapped_column(String(36), primary_key=True)
    email = mapped_column(String(255), nullable=False)
    is_active = mapped_column(Boolean, nullable=False, default=True)
