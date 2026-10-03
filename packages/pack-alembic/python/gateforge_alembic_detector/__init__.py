"""AST-only Alembic migration discovery for Gateforge (GPP/3 detector).

Parses Python migration files with the stdlib ast module and reports
Alembic migration revisions, lineage graphs, operations, and no-op
downgrades without importing or executing any application code.
"""

from __future__ import annotations

PLUGIN_ID = "gateforge.pack-alembic"
VERSION = "0.1.0"
