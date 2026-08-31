"""Cross-module inheritance consumer: child.py extends a base from
base.py in a sibling file.

- InheritedChild: no own __tablename__; resolves to "archive_rows"
  through cross_module.base.ArchiveBase (GF: cross-module resolution).
- RuntimeChild: inherits from a computed-name base (computed.py) — the
  chain carries no literal anywhere, so BOTH the detector's typed entry
  and the graph's synthesized inherited_tablename_unresolved stay.
"""

from sqlalchemy import Column, Integer

from .base import ArchiveBase
from .computed import ComputedBase


class InheritedChild(ArchiveBase):
    """No own tablename; the graph resolves it across files."""

    id = Column(Integer, primary_key=True)


class RuntimeChild(ComputedBase):
    """No own tablename; the base name is itself computed."""

    id = Column(Integer, primary_key=True)