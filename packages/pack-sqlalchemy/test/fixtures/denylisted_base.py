"""Denylisted base provenance (phase 2): the pathological aliasing killer.

``from pydantic import BaseModel as Base`` is the exact spelling that
slipped past every name-based rule in a real dogfood. The import map
binds ``Base`` to provenance ``pydantic.BaseModel``, so the denylist
vetoes the conventional-``Base`` rule for this file: the class below is
NOT a candidate — no symbol, no table, no unresolved entry. AST-only:
pydantic is never imported or executed.
"""

from pydantic import BaseModel as Base


class Contract(Base):
    """A Pydantic schema masquerading as ``Base``: never a table."""

    id: int
    payload: str
