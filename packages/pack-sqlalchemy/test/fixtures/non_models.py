"""Non-model classes (phase 2, detector precision): the false-positive zoo.

Every shape below historically became a SQLAlchemy table candidate under
the old ``has_facts or bool(self.bases)`` predicate — in a real dogfood
Pydantic schema directories alone produced ~1,100 false-positive
BLOCKING entries. Under the phase-2 predicate NONE of these classes is a
candidate: zero symbol resources, zero ``sqlalchemy.table`` resources,
zero unresolved entries.

Zero third-party imports on purpose: base classes are stand-ins defined
in-file (the scanner only parses — provenance is exercised by the
denylist fixture, `denylisted_base.py`, and by the aliased import at the
bottom, which the AST sees without importing pydantic).
"""

from enum import Enum
from abc import ABC, abstractmethod


class BaseModel:
    """Stand-in for pydantic.BaseModel (typed fields, no ORM facts)."""

    id: int
    name: str


class BaseSettings(BaseModel):
    """Stand-in for pydantic_settings.BaseSettings."""

    env_prefix: str = "app_"


class Settings(BaseSettings):
    """An app-settings shape: never a table."""

    debug: bool = False


class Foo(BaseModel):
    """Pydantic model with a nested config class: never a table."""

    email: str

    class Config:
        from_attributes = True


class Color(str, Enum):
    """An enum: never a table."""

    RED = "red"
    GREEN = "green"


class Num(int, Enum):
    """A second enum flavor: never a table."""

    ONE = 1


class Parser(ABC):
    """An abstract-base-class shape: never a table."""

    @abstractmethod
    def parse(self, text: str) -> dict:
        ...


class AppError(Exception):
    """An exception hierarchy root: never a table."""

    detail: str


class SomeService:
    """An arbitrary project base class: never a table."""


class Service(SomeService):
    """A plain subclass of a plain base: never a table."""


class TimestampMixin:
    """A plain mixin with NO bases: never a table."""

    created_at: str


class Invoice(BaseModel):
    """Second Pydantic shape with its own nested Config class.

    Together with Foo.Config this repeats the simple name ``Config``
    across distinct scopes. GF-01 must stay SILENT: neither Config
    emits anything, so no resource-name ambiguity can exist (phase 2
    detector precision — findings only cover emitting classes).
    """

    total: int

    class Config:
        from_attributes = True


# Import-provenance shapes (AST-only: pydantic is never executed).
from pydantic import BaseModel as PM


class Bar(PM):
    """Aliased Pydantic import: the denylist vetoes the base."""
