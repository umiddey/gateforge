from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class JobLock(Base):
    __tablename__ = "job_locks"
    id = Column(Integer, primary_key=True)


class AuditMark(Base):
    __tablename__ = "audit_marks"
    id = Column(Integer, primary_key=True)


class PartialRow(Base):
    __tablename__ = "partial_rows"
    id = Column(Integer, primary_key=True)


class BranchRow(Base):
    __tablename__ = "branch_rows"
    id = Column(Integer, primary_key=True)


class UnreturnedRow(Base):
    __tablename__ = "unreturned_rows"
    id = Column(Integer, primary_key=True)


class ClassRow(Base):
    __tablename__ = "class_rows"
    id = Column(Integer, primary_key=True)
