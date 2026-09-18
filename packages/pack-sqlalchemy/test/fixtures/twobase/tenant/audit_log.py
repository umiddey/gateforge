"""Two-Base fixture: tenant audit log.

Same ``__tablename__`` as the ADMIN tree's ``audit_log.py`` — the
consumer's exact collision shape. The trees sit on separate
``declarative_base()`` roots (separate ``MetaData``), so the
base-qualified GF-20 rule must keep this pair provably distinct: no
finding, in either tree.
"""

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from models_base import Base


class TwobaseTenantAuditLog(Base):
    __tablename__ = "twobase_audit_log"
    id = mapped_column(String(36), primary_key=True)
    action = mapped_column(String(255), nullable=False)
