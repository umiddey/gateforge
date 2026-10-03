"""SQLModel-shaped tables: the canonical FastAPI template's model style.

``class Item(SQLModel, table=True)`` declares a table whose name SQLModel
derives at runtime by lowercasing the class name. The detector must see
these tables (with that name), while a SQLModel class WITHOUT
``table=True`` is a plain (non-table) class and must stay invisible.
"""

from typing import Optional

from sqlmodel import Field, Relationship, SQLModel


class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True, max_length=255)


class Item(SQLModel, table=True):
    """Table name is derived: ``Item`` -> ``item``."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    hero_id: Optional[int] = Field(default=None, foreign_key="hero.id")
    hero: Optional[Hero] = Relationship(back_populates="items")


class NamedItem(Item, table=True):
    __tablename__ = "named_item"


class ItemCreate(SQLModel):
    """A non-table SQLModel class (table=True is absent): not a model."""

    name: str


class HeroStats(SQLModel, table=False):
    """Explicitly not a table."""

    count: int = 0
