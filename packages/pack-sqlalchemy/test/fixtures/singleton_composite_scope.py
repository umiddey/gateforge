"""A tenant scoped by a COMPOSITE owner-declared scope.

With ``tenancy.scopeColumns: [org_id, tenant_id]`` both columns carry the
tenancy scope, so ``unique(org_id, tenant_id)`` admits one row per tenant
(TAGGED) while ``unique(org_id)`` alone and ``unique(org_id, tenant_id,
kind)`` do not make a row unique per tenant (both NOT tagged).
"""
from sqlalchemy import Column, Integer, String, UniqueConstraint
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class OrgTenantSetting(Base):
    """Unique (org_id, tenant_id): exactly one row per tenant."""

    __tablename__ = "org_tenant_settings"
    __table_args__ = (
        UniqueConstraint("org_id", "tenant_id", name="uq_org_tenant_setting"),
    )

    id = Column(Integer, primary_key=True)
    org_id = Column(String(32), nullable=False)
    tenant_id = Column(String(32), nullable=False)
    label = Column(String(64))


class OrgSetting(Base):
    """Unique (org_id): one row per organization, not per tenant."""

    __tablename__ = "org_settings"
    __table_args__ = (UniqueConstraint("org_id", name="uq_org_setting"),)

    id = Column(Integer, primary_key=True)
    org_id = Column(String(32), nullable=False)
    label = Column(String(64))


class OrgTenantLabel(Base):
    """Unique (org_id, tenant_id, kind): the kind is not the tenancy."""

    __tablename__ = "org_tenant_labels"
    __table_args__ = (
        UniqueConstraint("org_id", "tenant_id", "kind", name="uq_org_tenant_label"),
    )

    id = Column(Integer, primary_key=True)
    org_id = Column(String(32), nullable=False)
    tenant_id = Column(String(32), nullable=False)
    kind = Column(String(16), nullable=False)