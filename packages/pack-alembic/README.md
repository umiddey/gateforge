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

## Failure matrix

`test/scanner.test.ts` covers the static cases without a database: duplicate revision ids, dangling parents, and multiple heads, all read with Python AST only.

`test/postgres.e2e.test.ts` covers the engine-run cases on a disposable PostgreSQL instance. It is skipped, with a printed reason, unless `GATEFORGE_ALEMBIC_TEST_ADMIN_URL` is set to an admin URL of a throwaway instance (for example a CI `postgres` service container). `GATEFORGE_ALEMBIC_TEST_PYTHON` optionally selects an interpreter that already has Alembic, SQLAlchemy, and a PostgreSQL driver; it defaults to `python3`.

| Case | Cause code |
| --- | --- |
| model changed with no migration in the same change | `MIGRATION_MISSING` |
| `downgrade()` is empty or incomplete | `MIGRATION_DOWNGRADE_NOOP` |
| migration chain does not match the models | `MIGRATION_DRIFT` |
| destructive rename after the seed is loaded | `MIGRATION_DATA_LOST` |
| two branches alter the same table, merge result keeps two heads | `MIGRATION_CONFLICT` |
| merge revision breaks a seeded row on the merge result | `MIGRATION_DATA_LOST` |
| failure injected right after the scratch database is created | `MIGRATION_ROUNDTRIP_FAILED`, database dropped |

The suite also asserts that only the `gf_tmp_<id>` name recorded during the run is dropped: a similarly named existing database and the configured application database both survive with their data.

`packages/cli/test/alembic-first-run.test.ts` proves the setup flow end to end: it copies `examples/alembic` into a fresh repository, runs `gateforge init`, writes the printed opt-in block verbatim (with the trusted admin URL filled in), and runs `check` and `next`. Without the block the run compiles no obligation at all; with it the engine witnesses the chain on a disposable database and the honest example produces no migration finding. Editing the model afterwards makes `check` and `next` report `MIGRATION_DRIFT`. It is skipped, with a printed reason, unless `GATEFORGE_ALEMBIC_TEST_ADMIN_URL` is set, and it needs `python3` to carry Alembic, SQLAlchemy, and a PostgreSQL driver because the engine runs `python3` exactly as production does.
