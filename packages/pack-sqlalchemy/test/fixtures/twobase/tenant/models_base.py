"""Two-Base fixture: TENANT tree base.

Deliberately uses the ``declarative_base()`` FACTORY bound to the same
variable name (``Base``) as the admin tree's base module — the consumer
shape whose cross-module resolution this fixture pins.
"""

from sqlalchemy.orm import declarative_base

Base = declarative_base()
