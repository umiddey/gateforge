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


class Route(Base):
    __tablename__ = "route"
    id = Column(Integer, primary_key=True)


class OnlyRow(Base):
    __tablename__ = "only_rows"
    id = Column(Integer, primary_key=True)


class ShadowTaskRow(Base):
    __tablename__ = "shadow_task_rows"
    id = Column(Integer, primary_key=True)


class ShadowRealTaskRow(Base):
    __tablename__ = "shadow_real_task_rows"
    id = Column(Integer, primary_key=True)


class ShadowParamSessionRow(Base):
    __tablename__ = "shadow_param_session_rows"
    id = Column(Integer, primary_key=True)


class ShadowLocalSessionRow(Base):
    __tablename__ = "shadow_local_session_rows"
    id = Column(Integer, primary_key=True)


class ShadowSessionmakerRow(Base):
    __tablename__ = "shadow_sessionmaker_rows"
    id = Column(Integer, primary_key=True)


class ShadowLiteralRow(Base):
    __tablename__ = "shadow_literal_rows"
    id = Column(Integer, primary_key=True)


class ShadowModuleSessionRow(Base):
    __tablename__ = "shadow_module_session_rows"
    id = Column(Integer, primary_key=True)


class ShadowRealSessionRow(Base):
    __tablename__ = "shadow_real_session_rows"
    id = Column(Integer, primary_key=True)


class ShadowRealSessionmakerRow(Base):
    __tablename__ = "shadow_real_sessionmaker_rows"
    id = Column(Integer, primary_key=True)


class ShadowRealLiteralRow(Base):
    __tablename__ = "shadow_real_literal_rows"
    id = Column(Integer, primary_key=True)


class LocalTableRow(Base):
    __tablename__ = "local_table_rows"
    id = Column(Integer, primary_key=True)


class TwiceTableRow(Base):
    __tablename__ = "twice_table_rows"
    id = Column(Integer, primary_key=True)


class LocalShadowRow(Base):
    __tablename__ = "local_shadow_rows"
    id = Column(Integer, primary_key=True)


class CursorWithRow(Base):
    __tablename__ = "cursor_with_rows"
    id = Column(Integer, primary_key=True)


class CursorAssignRow(Base):
    __tablename__ = "cursor_assign_rows"
    id = Column(Integer, primary_key=True)


class CursorParamRow(Base):
    __tablename__ = "cursor_param_rows"
    id = Column(Integer, primary_key=True)


class CursorConnRow(Base):
    __tablename__ = "cursor_conn_rows"
    id = Column(Integer, primary_key=True)
