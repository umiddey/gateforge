from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class SqlInsertRow(Base):
    __tablename__ = "sql_insert_rows"
    id = Column(Integer, primary_key=True)


class SqlUpdateRow(Base):
    __tablename__ = "sql_update_rows"
    id = Column(Integer, primary_key=True)


class SqlDeleteRow(Base):
    __tablename__ = "sql_delete_rows"
    id = Column(Integer, primary_key=True)


class TextInsertRow(Base):
    __tablename__ = "text_insert_rows"
    id = Column(Integer, primary_key=True)


class TextUpdateRow(Base):
    __tablename__ = "text_update_rows"
    id = Column(Integer, primary_key=True)


class TextDeleteRow(Base):
    __tablename__ = "text_delete_rows"
    id = Column(Integer, primary_key=True)


class TextSelectRow(Base):
    __tablename__ = "text_select_rows"
    id = Column(Integer, primary_key=True)


class TableInsertRow(Base):
    __tablename__ = "table_insert_rows"
    id = Column(Integer, primary_key=True)


class TableUpdateRow(Base):
    __tablename__ = "table_update_rows"
    id = Column(Integer, primary_key=True)


class TableDeleteRow(Base):
    __tablename__ = "table_delete_rows"
    id = Column(Integer, primary_key=True)


class AddAllRow(Base):
    __tablename__ = "add_all_rows"
    id = Column(Integer, primary_key=True)


class AddAllNegRow(Base):
    __tablename__ = "add_all_neg_rows"
    id = Column(Integer, primary_key=True)


class ParamRow(Base):
    __tablename__ = "param_rows"
    id = Column(Integer, primary_key=True)


class MakerRow(Base):
    __tablename__ = "maker_rows"
    id = Column(Integer, primary_key=True)


class TwiceRow(Base):
    __tablename__ = "twice_rows"
    id = Column(Integer, primary_key=True)


class HelperRow(Base):
    __tablename__ = "helper_rows"
    id = Column(Integer, primary_key=True)


class DynamicRow(Base):
    __tablename__ = "dynamic_rows"
    id = Column(Integer, primary_key=True)


class AmbiguousRow(Base):
    __tablename__ = "ambiguous_rows"
    id = Column(Integer, primary_key=True)


class SharedRow(Base):
    __tablename__ = "shared_rows"
    id = Column(Integer, primary_key=True)


class WorkerCallRow(Base):
    __tablename__ = "worker_call_rows"
    id = Column(Integer, primary_key=True)


class UnboundRow(Base):
    __tablename__ = "unbound_rows"
    id = Column(Integer, primary_key=True)


class MissingRow(Base):
    __tablename__ = "missing_rows"
    id = Column(Integer, primary_key=True)


class CycleRow(Base):
    __tablename__ = "cycle_rows"
    id = Column(Integer, primary_key=True)


class OrderRow(Base):
    __tablename__ = "order_rows"
    id = Column(Integer, primary_key=True)


class UpdRow(Base):
    __tablename__ = "func_update_rows"
    id = Column(Integer, primary_key=True)


class DelRow(Base):
    __tablename__ = "func_delete_rows"
    id = Column(Integer, primary_key=True)


class LocalRow(Base):
    __tablename__ = "local_insert_rows"
    id = Column(Integer, primary_key=True)


class FakeOpRow(Base):
    __tablename__ = "fake_op_rows"
    id = Column(Integer, primary_key=True)


class NorevRow(Base):
    __tablename__ = "norev_rows"
    id = Column(Integer, primary_key=True)


class LowerRow(Base):
    __tablename__ = "lower_rows"
    id = Column(Integer, primary_key=True)


class QuotedRow(Base):
    __tablename__ = "quoted_rows"
    id = Column(Integer, primary_key=True)


class DynRow(Base):
    __tablename__ = "dyn_rows"
    id = Column(Integer, primary_key=True)


class PlainRow(Base):
    __tablename__ = "plain_rows"
    id = Column(Integer, primary_key=True)


class AttrRow(Base):
    __tablename__ = "attr_rows"
    id = Column(Integer, primary_key=True)


class AliasRow(Base):
    __tablename__ = "alias_rows"
    id = Column(Integer, primary_key=True)


class HelperSessionRow(Base):
    __tablename__ = "helper_session_rows"
    id = Column(Integer, primary_key=True)


class OrmSessionRow(Base):
    __tablename__ = "orm_session_rows"
    id = Column(Integer, primary_key=True)


class ShadowRow(Base):
    __tablename__ = "shadow_rows"
    id = Column(Integer, primary_key=True)


class HelperServerRow(Base):
    __tablename__ = "helper_server_rows"
    id = Column(Integer, primary_key=True)


class ClassDup(Base):
    __tablename__ = "classdup_rows"
    id = Column(Integer, primary_key=True)


class BareRow(Base):
    __tablename__ = "bare_rows"
    id = Column(Integer, primary_key=True)


class TableAttrRow(Base):
    __tablename__ = "table_arg_rows"
    id = Column(Integer, primary_key=True)


class NestedMainRow(Base):
    __tablename__ = "nested_main_rows"
    id = Column(Integer, primary_key=True)


class DecoRow(Base):
    __tablename__ = "decorated_rows"
    id = Column(Integer, primary_key=True)


class ServeRow(Base):
    __tablename__ = "serve_rows"
    id = Column(Integer, primary_key=True)


class ServeForeverRow(Base):
    __tablename__ = "serve_forever_rows"
    id = Column(Integer, primary_key=True)


class BareRunRow(Base):
    __tablename__ = "bare_run_rows"
    id = Column(Integer, primary_key=True)


class DowngradeRow(Base):
    __tablename__ = "downgrade_rows"
    id = Column(Integer, primary_key=True)


class NonStrRow(Base):
    __tablename__ = "nonstring_rows"
    id = Column(Integer, primary_key=True)


class NestedRevRow(Base):
    __tablename__ = "nested_rev_rows"
    id = Column(Integer, primary_key=True)


class LocalSharedRow(Base):
    __tablename__ = "local_shared_rows"
    id = Column(Integer, primary_key=True)


class ForeignSharedRow(Base):
    __tablename__ = "foreign_shared_rows"
    id = Column(Integer, primary_key=True)


class UpdFakeRow(Base):
    __tablename__ = "fake_update_rows"
    id = Column(Integer, primary_key=True)


class DelFakeRow(Base):
    __tablename__ = "fake_delete_rows"
    id = Column(Integer, primary_key=True)


class ClassRow(Base):
    __tablename__ = "class_rows"
    id = Column(Integer, primary_key=True)


class FakeExecRow(Base):
    __tablename__ = "fake_exec_rows"
    id = Column(Integer, primary_key=True)


class LocalExecRow(Base):
    __tablename__ = "local_exec_rows"
    id = Column(Integer, primary_key=True)


class FakeTextRow(Base):
    __tablename__ = "fake_text_rows"
    id = Column(Integer, primary_key=True)


class LocalTextRow(Base):
    __tablename__ = "local_text_rows"
    id = Column(Integer, primary_key=True)


class ForeignSessionRow(Base):
    __tablename__ = "foreign_session_rows"
    id = Column(Integer, primary_key=True)


class ForeignOrmSessionRow(Base):
    __tablename__ = "foreign_orm_session_rows"
    id = Column(Integer, primary_key=True)


class ClassDup(Base):
    __tablename__ = "classdup_rows"
    id = Column(Integer, primary_key=True)
