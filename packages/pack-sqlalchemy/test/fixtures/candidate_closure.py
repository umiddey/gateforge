"""Multi-level inheritance closure ACROSS files (phase 2).

``Contractor(SalariedEmployee)`` has no table facts and no declarative
root of its own: candidacy arrives only through the global model-name
closure — ``Account(Base)`` (candidates.py, has facts) →
``SalariedEmployee(Account)`` (candidates.py, closure) → ``Contractor``
(this file, closure) — resolved iteratively to a fixpoint over ALL
scanned files in the request. Scanned WITHOUT candidates.py this class
is (correctly) NOT a candidate: a flat file scan cannot know an
unresolvable base is a model, and guessing is exactly the old bug.
"""

from sqlalchemy import Column, Integer

from .candidates import SalariedEmployee


class Contractor(SalariedEmployee):
    """Third link of a cross-file inheritance chain: a genuine table."""

    id = Column(Integer, primary_key=True)
