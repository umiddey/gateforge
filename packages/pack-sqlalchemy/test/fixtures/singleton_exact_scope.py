"""Singleton tables: the unique constraint must cover EXACTLY the scope.

Three shapes, all tenant-plane, each proving one rule:

* ``tenant_profile`` — ``unique(tenant_id)`` alone. At most one row per
  tenant, so its create is provable only on a fresh tenant. TAGGED.
* ``heating_information_recipients`` — ``unique(period_id, tenant_id,
  contract_id, recipient_user_id)``: one row per RECIPIENT per period, so
  many rows per tenant exist. Its ``tenant_id`` is a domain column (the
  renter), not the tenancy scope. NOT tagged.
* ``ledger_period_settings`` — ``unique(period_id, tenant_id)``. The period
  distinguishes more than the tenancy, so repeated creates per tenant are
  legitimate. NOT tagged.

Facts emitted here are ADDITIVE attributes (``uniqueConstraints``); the
per-tenant-singleton tag is minted in the TypeScript wrapper, where the
plane evidence and the owner's declared scope columns live.
"""
from sqlalchemy import Column, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class TenantProfile(Base):
    """Unique (tenant_id): exactly one row per tenant."""

    __tablename__ = "tenant_profiles"
    __table_args__ = (UniqueConstraint("tenant_id", name="uq_tenant_profile_tenant"),)

    id = Column(Integer, primary_key=True)
    tenant_id = Column(String(32), ForeignKey("tenants.id"), nullable=False)
    display_name = Column(String(64))


class HeatingInformationRecipient(Base):
    """Unique per recipient per period: many rows per tenant are normal."""

    __tablename__ = "heating_information_recipients"
    __table_args__ = (
        UniqueConstraint(
            "period_id",
            "tenant_id",
            "contract_id",
            "recipient_user_id",
            name="uq_heating_information_recipient_identity",
        ),
    )

    id = Column(Integer, primary_key=True)
    period_id = Column(String(32), nullable=False)
    tenant_id = Column(String(32), nullable=False)
    contract_id = Column(String(32), nullable=False)
    recipient_user_id = Column(String(32), nullable=False)


class LedgerPeriodSetting(Base):
    """Unique (period_id, tenant_id): the period is not the tenancy."""

    __tablename__ = "ledger_period_settings"
    __table_args__ = (
        UniqueConstraint("period_id", "tenant_id", name="uq_ledger_period_tenant"),
    )

    id = Column(Integer, primary_key=True)
    period_id = Column(String(32), nullable=False)
    tenant_id = Column(String(32), nullable=False)
    value = Column(String(32))