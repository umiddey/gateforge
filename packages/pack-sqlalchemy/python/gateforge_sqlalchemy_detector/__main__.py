#!/usr/bin/env python3
"""GPP/3 serve entry for the Gateforge SQLAlchemy detector.

Runnable as a module so the CLI's subprocess transport can invoke it with
``python3 -m gateforge_sqlalchemy_detector`` (G4 surface): handshake,
one lock-step ``discover`` per request, shutdown handshake — all through
the reference client in @gate-forge/plugin-protocol (stdlib only).

The module locates the ``gateforge_plugin`` client itself: when it is not
importable from the environment (e.g. only this pack's ``python/`` dir is
on ``PYTHONPATH`` in the monorepo layout), the sibling copy shipped by
``packages/plugin-protocol/python`` is bootstrapped onto ``sys.path``.

Usage:
    python3 -m gateforge_sqlalchemy_detector [root]
    # root: scan root (default: process cwd, which the CLI sets to the
    #       repo root); every discover path resolves under it.
    # --internal-entry-categories=LIST: comma list of migration,
    #       maintenance-command, worker; the host passes the trusted internal
    #       entry points it grants. Absent: no internal claims are derived.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:  # installed / environment-provided client
    from gateforge_plugin import ProtocolError, serve
except ImportError:  # monorepo bootstrap: ../plugin-protocol/python
    _protocol_py = Path(__file__).resolve().parents[3] / "plugin-protocol" / "python"
    sys.path.insert(0, str(_protocol_py))
    from gateforge_plugin import ProtocolError, serve  # noqa: E402

from gateforge_sqlalchemy_detector import PLUGIN_ID, VERSION


_ENTRY_CATEGORIES = ("migration", "maintenance-command", "worker")
_CATEGORY_FLAG = "--internal-entry-categories="
_scan_root: Path | None = None
_categories: tuple[str, ...] = ()


def _parse_categories(value: str) -> tuple[str, ...]:
    """Validates a comma list of entry categories; an unknown name is an error."""
    names = tuple(part for part in value.split(",") if part)
    unknown = [name for name in names if name not in _ENTRY_CATEGORIES]
    if unknown:
        raise ValueError(f"unknown internal entry category: {', '.join(unknown)}")
    return names


def _parse_args(argv: list[str]) -> tuple[Path | None, tuple[str, ...]]:
    """Splits argv into the optional scan root and the derived entry categories."""
    root: Path | None = None
    categories: tuple[str, ...] = ()
    for arg in argv:
        if arg.startswith(_CATEGORY_FLAG):
            categories = _parse_categories(arg[len(_CATEGORY_FLAG):])
        elif not arg.startswith("--") and root is None:
            root = Path(arg).resolve()
    return root, categories


def _discover(paths: list[str]) -> dict:
    """GPP/3 discover handler: scans each repo-relative path in order."""
    from gateforge_sqlalchemy_detector import scan

    return scan.scan(paths, _scan_root, _categories)


if __name__ == "__main__":
    try:
        _scan_root, _categories = _parse_args(sys.argv[1:])
    except ValueError as error:
        print(error, file=sys.stderr)
        raise SystemExit(2) from None
    try:
        raise SystemExit(serve(PLUGIN_ID, VERSION, _discover))
    except ProtocolError as error:
        print(f"gateforge_sqlalchemy_detector: {error}", file=sys.stderr)
        raise SystemExit(4) from None