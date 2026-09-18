"""Cross-file SAME-Base duplicate fixture (GF-20 base-qualified variant).

Imports ``collisions.Base`` — the same ``MetaData`` root the
``collisions.py`` tables sit on — and re-declares the ``shared_items``
tablename: a REAL runtime collision that must stay flagged, proving the
base-qualified rule still fires when the shared root arrives through an
import. A plain ``Table()`` call with the same name carries no class
evidence, so a group containing it can never be proven distinct (fail
closed).

Contrast with ``modern_declarative.py``, whose LOCAL ``Base`` is a
different root: its ``shared_items`` no longer collides with
``collisions.py`` under the base-qualified rule.
"""

from sqlalchemy import Column, Integer, MetaData, Table

from collisions import Base


class SharedItemsHistory(Base):
    """Second declaration of table 'shared_items' — SAME Base via import."""

    __tablename__ = "shared_items"
    id = Column(Integer, primary_key=True)


SHARED_ITEMS_RAW = Table(
    "shared_items",
    MetaData(),
    Column("id", Integer, primary_key=True),
)
