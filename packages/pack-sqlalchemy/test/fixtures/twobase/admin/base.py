"""Two-Base fixture: ADMIN (master) tree base.

A SECOND ``Base = declarative_base()`` in a different module — the
control-plane tree is a separate metadata from the tenant tree.
"""

from sqlalchemy.orm import declarative_base

Base = declarative_base()
