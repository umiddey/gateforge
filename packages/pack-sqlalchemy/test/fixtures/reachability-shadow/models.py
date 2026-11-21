from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class ShadowParamRow(Base):
    __tablename__ = "shadow_param_rows"
    id = Column(Integer, primary_key=True)


class ShadowDefRow(Base):
    __tablename__ = "shadow_def_rows"
    id = Column(Integer, primary_key=True)


class ShadowLocalRow(Base):
    __tablename__ = "shadow_local_rows"
    id = Column(Integer, primary_key=True)


class ShadowRealRow(Base):
    __tablename__ = "shadow_real_rows"
    id = Column(Integer, primary_key=True)
