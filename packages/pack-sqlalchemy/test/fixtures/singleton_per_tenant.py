"""Per-tenant singleton tables: unique constraints and the tenant scope.

``tenant_profiles`` (a UNIQUE CONSTRAINT) and ``tenant_quotas`` (a UNIQUE
INDEX) are written over the tenancy scope ALONE, so at most one row per
tenant exists. ``ledger_entries`` and ``meters`` merely CONTAIN a scope
column beside columns that distinguish more than the tenancy, so many rows
per tenant exist and they are NOT singletons.

Facts emitted here are ADDITIVE attributes (``uniqueConstraints``): what the
detector can see statically about uniqueness. The tenant-scope tag itself is
minted in the TypeScript wrapper, which is where plane evidence lives.
"""
from sqlalchemy import Column, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class LedgerEntry(Base):
    """Unique (tenant, ledger, kind): many rows per tenant are legitimate."""

    __tablename__ = "ledger_entries"
    __table_args__ = (
        UniqueConstraint("tenant_id", "ledger", "kind", name="uq_ledger_tenant_ledger_kind"),
    )

    id = Column(Integer, primary_key=True)
    tenant_id = Column(String(32), nullable=False)
    ledger = Column(String(32), nullable=False)
    kind = Column(String(16), nullable=False)


class TenantProfile(Base):
    """Unique (tenant_id): exactly one row per tenant — a real singleton."""

    __tablename__ = "tenant_profiles"
    __table_args__ = (UniqueConstraint("tenant_id", name="uq_tenant_profile_tenant"),)

    id = Column(Integer, primary_key=True)
    tenant_id = Column(String(32), nullable=False)
    display_name = Column(String(64))


class TenantQuota(Base):
    """The same fact expressed as a UNIQUE INDEX over the tenant scope."""

    __tablename__ = "tenant_quotas"
    __table_args__ = (Index("ux_tenant_quota_tenant", "tenant_id", unique=True),)

    id = Column(Integer, primary_key=True)
    tenant_id = Column(String(32), nullable=False)


class Meter(Base):
    """Unique (tenant_id, serial): the serial distinguishes more rows."""

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
    label = Column(String(64))