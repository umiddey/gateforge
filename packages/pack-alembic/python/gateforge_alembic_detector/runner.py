"""Engine-owned Alembic roundtrip runner.

Connects only to a database whose name starts with ``gf_tmp_``. The
project's ``env.py`` is never imported. Schema comparison excludes
``alembic_version``.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SCRATCH_PREFIX = "gf_tmp_"


def _fail(cause: str, detail: str) -> dict[str, Any]:
    """One failed runner result.

    Args:
        cause (str): Stable cause code.
        detail (str): Single-cause explanation.

    Returns:
        dict[str, Any]: Result with ``ok`` false.
    """
    return {"ok": False, "cause": cause, "detail": detail}


def _database_name(url: str) -> str | None:
    """Return the database name from a SQLAlchemy or libpq URL.

    Args:
        url (str): Database URL.

    Returns:
        str | None: The path database name, or None when absent.
    """
    parsed = urlparse(url.replace("postgresql+psycopg://", "postgresql://", 1).replace("postgresql+psycopg2://", "postgresql://", 1))
    name = parsed.path.lstrip("/")
    return name or None


def _assert_scratch(url: str) -> str | None:
    """Refuse any URL whose database is not a Gateforge scratch database.

    Args:
        url (str): Candidate migration URL.

    Returns:
        str | None: An error detail, or None when the name is disposable.
    """
    name = _database_name(url)
    if name is None or not name.startswith(SCRATCH_PREFIX) or name == SCRATCH_PREFIX:
        return f"refusing database URL whose name is not {SCRATCH_PREFIX}<id>"
    if not name.removeprefix(SCRATCH_PREFIX).isalnum():
        return f"refusing database name '{name}'"
    return None


def _driver_url(url: str) -> str:
    """Rewrite a plain postgres URL to an installed SQLAlchemy driver.

    Args:
        url (str): ``postgresql://`` URL.

    Returns:
        str: A driver-qualified URL.

    Raises:
        RuntimeError: When neither psycopg nor psycopg2 imports.
    """
    if url.startswith("postgresql+"):
        return url
    if not url.startswith("postgresql://"):
        raise RuntimeError("scratch URL must be a postgresql URL")
    for driver in ("psycopg", "psycopg2"):
        try:
            __import__(driver)
        except ImportError:
            continue
        return url.replace("postgresql://", f"postgresql+{driver}://", 1)
    raise RuntimeError("no postgres driver installed (need psycopg or psycopg2)")


def _metadata(module_name: str, attr_path: str) -> Any:
    """Import the configured metadata object.

    Args:
        module_name (str): Importable module name.
        attr_path (str): Dotted attribute path, e.g. ``Base.metadata``.

    Returns:
        Any: SQLAlchemy MetaData.
    """
    module = importlib.import_module(module_name)
    target: Any = module
    for part in attr_path.split("."):
        target = getattr(target, part)
    return target


def _write_env(directory: Path, models_module: str, metadata_attr: str) -> None:
    """Write an engine-owned env.py that refuses non-scratch URLs.

    Args:
        directory (Path): Temporary script location.
        models_module (str): Module that owns the metadata.
        metadata_attr (str): Attribute path on that module.

    Returns:
        None: Writes ``env.py``.
    """
    directory.mkdir(parents=True, exist_ok=True)
    script = f"""
from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config
url = config.get_main_option("sqlalchemy.url") or ""
name = url.rstrip("/").rsplit("/", 1)[-1].split("?")[0]
if not name.startswith("{SCRATCH_PREFIX}"):
    raise RuntimeError("refusing non-disposable database")
import importlib
module = importlib.import_module({models_module!r})
target = module
for part in {metadata_attr!r}.split("."):
    target = getattr(target, part)
target_metadata = target

def run_migrations_offline():
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()

def run_migrations_online():
    connectable = engine_from_config(
        config.get_section(config.config_ini_section) or {{}},
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
"""
    (directory / "env.py").write_text(script, encoding="utf-8")
    (directory / "script.py.mako").write_text("", encoding="utf-8")


def _config(scratch_url: str, versions_dir: str, models_module: str, metadata_attr: str, python_path: list[str]) -> Any:
    """Build an Alembic config that never reads the project's env.py.

    Args:
        scratch_url (str): Disposable database URL.
        versions_dir (str): Absolute versions directory.
        models_module (str): Metadata module.
        metadata_attr (str): Metadata attribute path.
        python_path (list[str]): Extra import roots.

    Returns:
        Any: Alembic Config.
    """
    from alembic.config import Config
    import tempfile

    refused = _assert_scratch(scratch_url)
    if refused is not None:
        raise RuntimeError(refused)
    for entry in python_path:
        if entry not in sys.path:
            sys.path.insert(0, entry)
    script_dir = Path(tempfile.mkdtemp(prefix="gf-alembic-env-"))
    _write_env(script_dir, models_module, metadata_attr)
    ini = script_dir / "alembic.ini"
    driver_url = _driver_url(scratch_url)
    ini.write_text(
        "\n".join(
            [
                "[alembic]",
                f"script_location = {script_dir}",
                f"version_locations = {versions_dir}",
                f"sqlalchemy.url = {driver_url}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    cfg = Config(str(ini))
    cfg.set_main_option("script_location", str(script_dir))
    cfg.set_main_option("version_locations", versions_dir)
    cfg.set_main_option("sqlalchemy.url", driver_url)
    return cfg


def _snapshot(url: str) -> dict[str, Any]:
    """Capture a deterministic public-schema snapshot.

    Args:
        url (str): Scratch database URL.

    Returns:
        dict[str, Any]: Tables, columns, constraints, indexes, enums, sequences.
    """
    from sqlalchemy import create_engine, text

    refused = _assert_scratch(url)
    if refused is not None:
        raise RuntimeError(refused)
    engine = create_engine(_driver_url(url))
    queries = {
        "tables": """
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
              AND table_name <> 'alembic_version'
            ORDER BY table_name
        """,
        "columns": """
            SELECT table_name, column_name, data_type, udt_name, is_nullable,
                   coalesce(column_default, ''), coalesce(character_maximum_length, 0),
                   coalesce(numeric_precision, 0)
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name <> 'alembic_version'
            ORDER BY table_name, ordinal_position
        """,
        "constraints": """
            SELECT rel.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid)
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
            WHERE nsp.nspname = 'public' AND rel.relname <> 'alembic_version'
            ORDER BY rel.relname, con.conname
        """,
        "indexes": """
            SELECT tablename, indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public' AND tablename <> 'alembic_version'
            ORDER BY tablename, indexname
        """,
        "enums": """
            SELECT t.typname, e.enumlabel
            FROM pg_type t
            JOIN pg_enum e ON e.enumtypid = t.oid
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public'
            ORDER BY t.typname, e.enumsortorder
        """,
        "sequences": """
            SELECT sequence_name, data_type, start_value, increment
            FROM information_schema.sequences
            WHERE sequence_schema = 'public'
            ORDER BY sequence_name
        """,
    }
    snapshot: dict[str, Any] = {}
    with engine.connect() as connection:
        for key, sql in queries.items():
            rows = connection.execute(text(sql)).fetchall()
            snapshot[key] = [list(row) for row in rows]
    engine.dispose()
    return snapshot


def _ident(name: str) -> str:
    """Quote a trusted SQL identifier.

    Args:
        name (str): Table or column name.

    Returns:
        str: Quoted identifier.

    Raises:
        RuntimeError: When the name is not a simple identifier.
    """
    if not name or not name.replace("_", "a").isalnum() or name[0].isdigit():
        raise RuntimeError(f"refusing SQL identifier '{name}'")
    return '"' + name.replace('"', "") + '"'


def _fingerprints(url: str, tables: list[dict[str, Any]]) -> dict[str, Any]:
    """Count rows and hash declared columns.

    Args:
        url (str): Scratch database URL.
        tables (list[dict[str, Any]]): Declared tables and columns.

    Returns:
        dict[str, Any]: Per-table count and column fingerprints.
    """
    from sqlalchemy import create_engine, text

    refused = _assert_scratch(url)
    if refused is not None:
        raise RuntimeError(refused)
    engine = create_engine(_driver_url(url))
    result: dict[str, Any] = {}
    with engine.connect() as connection:
        for table in tables:
            name = str(table["name"])
            columns = [str(column) for column in table["columns"]]
            count = connection.execute(text(f"SELECT count(*) FROM {_ident(name)}")).scalar_one()
            column_hashes: dict[str, str | None] = {}
            existing = {
                row[0]
                for row in connection.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = 'public' AND table_name = :table"
                    ),
                    {"table": name},
                )
            }
            for column in columns:
                if column not in existing:
                    column_hashes[column] = None
                    continue
                digest = connection.execute(
                    text(
                        f"SELECT md5(coalesce(string_agg({_ident(column)}::text, ',' ORDER BY {_ident(column)}::text), '')) "
                        f"FROM {_ident(name)}"
                    )
                ).scalar_one()
                column_hashes[column] = str(digest)
            result[name] = {"count": int(count), "columns": column_hashes}
    engine.dispose()
    return result


def run(payload: dict[str, Any]) -> dict[str, Any]:
    """Run one engine command against a scratch database.

    Args:
        payload (dict[str, Any]): Command document from the TypeScript runner.

    Returns:
        dict[str, Any]: ``ok`` plus snapshots, fingerprints, or a cause.
    """
    command_name = str(payload.get("command") or "")
    scratch_url = str(payload.get("scratchUrl") or "")
    refused = _assert_scratch(scratch_url)
    if refused is not None:
        return _fail("MIGRATION_SCRATCH_UNSAFE", refused)
    try:
        if command_name == "snapshot":
            return {"ok": True, "snapshot": _snapshot(scratch_url)}
        if command_name == "fingerprint":
            return {"ok": True, "fingerprints": _fingerprints(scratch_url, list(payload.get("tables") or []))}
        if command_name != "alembic":
            return _fail("MIGRATION_ROUNDTRIP_FAILED", f"unknown runner command '{command_name}'")
        from alembic import command

        cfg = _config(
            scratch_url,
            str(payload["versionsDir"]),
            str(payload["modelsModule"]),
            str(payload.get("metadataAttr") or "Base.metadata"),
            list(payload.get("pythonPath") or []),
        )
        action = str(payload.get("action") or "")
        if action == "upgrade":
            command.upgrade(cfg, str(payload.get("revision") or "head"))
        elif action == "downgrade":
            command.downgrade(cfg, str(payload.get("revision") or "base"))
        elif action == "check":
            command.check(cfg)
        elif action == "sql":
            from sqlalchemy import create_engine, text

            engine = create_engine(_driver_url(scratch_url))
            with engine.begin() as connection:
                connection.execute(text(str(payload.get("sql") or "")))
            engine.dispose()
        else:
            return _fail("MIGRATION_ROUNDTRIP_FAILED", f"unknown alembic action '{action}'")
        return {"ok": True}
    except Exception as err:  # noqa: BLE001 — runner boundary, mapped to a cause
        text_err = f"{type(err).__name__}: {err}"
        cause = "MIGRATION_ROUNDTRIP_FAILED"
        lowered = text_err.lower()
        if "no postgres driver" in lowered or "refusing" in lowered:
            cause = "MIGRATION_SCRATCH_UNSAFE"
        elif "target database is not up to date" in lowered or "new upgrade operations" in lowered:
            cause = "MIGRATION_DRIFT"
        return _fail(cause, text_err.splitlines()[-1][:500])


def main() -> int:
    """Read one JSON command from stdin and write one JSON result.

    Returns:
        int: Process exit code. Always 0 when a JSON result was written.
    """
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as err:
        json.dump(_fail("MIGRATION_ROUNDTRIP_FAILED", f"runner payload is not JSON: {err}"), sys.stdout)
        return 0
    if not isinstance(payload, dict):
        json.dump(_fail("MIGRATION_ROUNDTRIP_FAILED", "runner payload must be an object"), sys.stdout)
        return 0
    try:
        json.dump(run(payload), sys.stdout)
    except Exception:  # noqa: BLE001 — last-resort boundary
        json.dump(_fail("MIGRATION_ROUNDTRIP_FAILED", traceback.format_exc().splitlines()[-1]), sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
