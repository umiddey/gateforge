"""AST-only SQLAlchemy table discovery for Gateforge (GPP/2 detector).

Parses Python source with the stdlib ``ast`` module and reports
SQLAlchemy declarative tables, abstract bases, and raw ``Table()``
declarations WITHOUT importing or executing any application code
(plan §4.1). Stdlib only (Python >= 3.11); the GPP/2 serve loop lives in
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
- ``unresolved`` entries: typed reasons (``computed_tablename``,
  ``table_name_derived_runtime``, ``no_tablename_source``) located at
  the class statement; the graph retires them when it resolves the name
  and synthesizes ``inherited_tablename_unresolved`` when it cannot
  (GF-21: computed identity is typed, never absent).
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