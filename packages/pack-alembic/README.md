# @gate-forge/pack-alembic

Opt-in Alembic migration obligations. A repository without an `alembic` key in `.gateforge.yml` behaves exactly as before; no migration obligations are added.

When enabled, Gateforge parses migration scripts with Python AST only, then runs `upgrade` → `downgrade base` → `upgrade` against an engine-created `gf_tmp_<id>` database and drops it. The trusted admin URL comes only from this configuration, never from the test environment. Suite claims cannot satisfy these obligations.

```yaml
alembic:
  chains:
    - name: invoices
      migrations: migrations/versions
      models:
        - models.py
      # Optional; defaults shown:
      alembicIni: alembic.ini
      modelsModule: models
      metadata: Base.metadata
  scratch:
    adminUrl: postgresql://gateforge:gateforge@127.0.0.1:5432/postgres
  # Optional: seed existing rows, verify counts/fingerprints, and declare renames.
  seed:
    path: tests/seed.sql
    tables:
      - name: invoices
        columns: [id, number]
        copies:
          - from: legacy_number
            to: number
  # Optional owner-approved irreversible revisions.
  irreversible: []
  # Optional; validates against target branch merge result.
  merge:
    targetRef: origin/main
```

`gateforge init` prints an opt-in template when `alembic.ini` exists; it does not enable the pack. Add the block to `.gateforge.yml`, provide a disposable Postgres service and a trusted admin URL, then run `gateforge check`.

The migration runner requires Alembic, SQLAlchemy, and a PostgreSQL driver (`psycopg` or `psycopg2`) in its Python environment. It does not import the project's `env.py`. The runner snapshots tables, columns, constraints, indexes, enums, and sequences, excluding `alembic_version`. With `seed`, it compares row counts and declared column fingerprints across the migration. A configured merge target is tested in a temporary Git worktree.

Cause codes (all additive): `MIGRATION_MISSING`, `MIGRATION_LINEAGE_BROKEN`, `MIGRATION_DOWNGRADE_NOOP`, `MIGRATION_DRIFT`, `MIGRATION_ROUNDTRIP_FAILED`, `MIGRATION_DATA_LOST`, `MIGRATION_CONFLICT`, `MIGRATION_SCRATCH_UNSAFE`.
