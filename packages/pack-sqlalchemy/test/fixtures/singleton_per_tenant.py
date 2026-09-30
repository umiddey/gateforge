"""Per-tenant singleton tables: a unique constraint that includes the tenant scope.

Facts emitted here are ADDITIVE attributes (``uniqueConstraints``): what the
detector can see statically about uniqueness. The tenant-scope tag itself is
minted in the TypeScript wrapper, which is where plane evidence lives.
"""
from sqlalchemy import Column, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class LedgerEntry(Base):
    """Unique (tenant, ledger, kind): at most one create per fresh tenant."""

    __tablename__ = "ledger_entries"
    __table_args__ = (
        UniqueConstraint("tenant_id", "ledger", "kind", name="uq_ledger_tenant_ledger_kind"),
    )

    id = Column(Integer, primary_key=True)
    tenant_id = Column(String(32), nullable=False)
    ledger = Column(String(32), nullable=False)
    kind = Column(String(16), nullable=False)


class Meter(Base):
    """The same fact expressed as a UNIQUE INDEX over the tenant scope."""

    __tablename__ = "meters"
    __table_args__ = (Index("ux_meters_tenant_serial", "tenant_id", "serial", unique=True),)

    id = Column(Integer, primary_key=True)
    tenant_id = Column(String(32), nullable=False)
    serial = Column(String(32), nullable=False)


class Coupon(Base):
    """Unique on a non-tenant column: two tenants may both create a coupon."""

    __tablename__ = "coupons"
    __table_args__ = (UniqueConstraint("code"),)

    id = Column(Integer, primary_key=True)
    tenant_id = Column(String(32), nullable=False)
    code = Column(String(32), nullable=False)


class TenantSetting(Base):
    """Tenant-scoped, no unique constraint: repeated creates are legitimate."""

    __tablename__ = "tenant_settings"

    id = Column(Integer, primary_key=True)
    tenant_id = Column(String(32), nullable=False)
    label = Column(String(64), nullable=False)
