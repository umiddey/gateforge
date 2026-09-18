"""Two-Base fixture: admin (master) audit log.

Same ``__tablename__`` as the TENANT tree's ``audit_log.py``; a
different declarative root (``base.Base`` of the admin tree), so the
base-qualified GF-20 rule keeps the pair provably distinct — the
intentional multi-plane split never blocks the gate.
"""

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from base import Base


class TwobaseAdminAuditLog(Base):
    __tablename__ = "twobase_audit_log"
    id = mapped_column(String(36), primary_key=True)
    action = mapped_column(String(255), nullable=False)
