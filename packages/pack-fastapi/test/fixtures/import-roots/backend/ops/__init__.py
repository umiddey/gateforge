"""Fixture package: `from ops import router` binds through THIS __init__.

There is no ``ops/router.py``: the name is a module-level re-export of the
``ops.endpoints`` router — the package-attribute import shape
(``from pkg import attr`` where ``attr`` is an ``__init__`` binding).
"""

from .endpoints import router
