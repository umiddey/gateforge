"""AST-only SQLAlchemy table discovery for Gateforge (GPP/3 detector).

Parses Python source with the stdlib ``ast`` module and reports
SQLAlchemy declarative tables, abstract bases, and raw ``Table()``
declarations WITHOUT importing or executing any application code
(plan §4.1). Stdlib only (Python >= 3.11); the GPP/3 serve loop lives in
``__main__.py`` and uses the reference client from
``@gateforge/plugin-protocol``.

Detector vocabulary (frozen with the pack):
- Business resources: ``kind`` ``sqlalchemy.table``; the identity
  attribute ``resourceName`` carries the literal table name. Class
  declarations additionally carry ``classQname`` (dotted scope-qualified
  name), ``scope``, ``tableName``, ``tablenameProvenance``,
  ``hasTableArgs``/``tableArgsSchema``, ``tableKeywordTrue``,
  ``abstract`` (always ``false`` for tables), and ``baseNames``.
- Class-symbol resources: ``kind`` ``gateforge.class`` with the graph's
  canonical attributes ``qname``, ``resourceKind``, ``baseNames``,
  ``tableName``, ``abstract``, ``tablenameUnresolved`` (GF-01/02 ID
  rules; cross-module inheritance is resolved by the graph's symbol
  table, never by this detector).
- Table-candidate recognition (phase 2, detector precision): ONLY
  classes with explicit table facts or a base that conservatively
  resolves to a declarative base are candidates — the exact
  conventional name ``Base``, literal ``DeclarativeBase``, a locally
  registered declarative alias (``declarative_base()``,
  ``registry().generate_base()``, ``class X(DeclarativeBase)``), or the
  simple name of an already-detected model class (inheritance closure
  to a fixpoint). Base names bound (possibly via import aliasing) from
  known non-ORM families — ``pydantic``, ``abc``, ``enum``,
  ``argparse``, ``dataclasses``, ``marshmallow``, ``fastapi`` — can
  never qualify. A non-candidate class is emitted NOWHERE: no symbol,
  no table, no unresolved entry.
- ``unresolved`` entries: typed reasons (``computed_tablename``,
  ``table_name_derived_runtime``, ``no_tablename_source``) located at
  the class statement; the graph retires them when it resolves the name
  and synthesizes ``inherited_tablename_unresolved`` when it cannot
  (GF-21: computed identity is typed, never absent).
- ``classificationSignals`` (plan phase 3, ADR 0003 D1): code-derived
  FACTS for the core classifier — ordered ``identity`` (primary-key)
  signals; ``delete-semantics``/``archive-state``/``lifecycle.*``
  declaration signals from the machine-readable declarations
  ``__gateforge_delete_semantics__``, ``__gateforge_archive_state__``,
  ``__gateforge_read_only__``; never an exposure claim (a table
  declaration proves nothing about external reachability).
- additional table attributes: ``primaryKeyColumns``,
  ``foreignKeyReferences`` (literal ``ForeignKey`` targets),
  ``softDeleteCandidateFields`` (bookkeeping-resembling column names —
  facts for reviewers, never semantics), ``readOnly``.
- additional unresolved entries: ``PRIMARY_KEY_UNRESOLVED`` (computed
  or invisible primary key — the key is never defaulted to ``id``) and
  ``ARCHIVE_STATE_UNRESOLVED`` (non-literal archive declaration).
- ``findings``: ``DUPLICATE_TABLE_NAME`` (GF-20: 2-file and 1-file
  variants), ``CLASS_NAME_REPEATED_IN_FILE`` (GF-01 non-collapse), and
  ``PARSE_ERROR`` (GF-19: malformed files never crash the scan and
  contribute no resources).

Determinism contract (plan invariant 7): identical input paths and file
bytes produce byte-identical output. No clocks, no network, no
randomness; every emitted array is sorted; every name is a literal from
the AST; ``json.dumps(..., sort_keys=True)`` in the client frame is the
canonical serializer.
"""

from __future__ import annotations

PLUGIN_ID = "gateforge.pack-sqlalchemy"
VERSION = "0.1.0"