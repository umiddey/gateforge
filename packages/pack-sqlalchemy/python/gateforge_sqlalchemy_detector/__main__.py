#!/usr/bin/env python3
"""GPP/2 serve entry for the Gateforge SQLAlchemy detector.

Runnable as a module so the CLI's subprocess transport can invoke it with
``python3 -m gateforge_sqlalchemy_detector`` (G4 surface): handshake,
one lock-step ``discover`` per request, shutdown handshake — all through
the reference client in @gateforge/plugin-protocol (stdlib only).

The module locates the ``gateforge_plugin`` client itself: when it is not
importable from the environment (e.g. only this pack's ``python/`` dir is
on ``PYTHONPATH`` in the monorepo layout), the sibling copy shipped by
``packages/plugin-protocol/python`` is bootstrapped onto ``sys.path``.

Usage:
    python3 -m gateforge_sqlalchemy_detector [root]
    # root: scan root (default: process cwd, which the CLI sets to the
    #       repo root); every discover path resolves under it.
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


_scan_root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None


def _discover(paths: list[str]) -> dict:
    """GPP/2 discover handler: scans each repo-relative path in order."""
    from gateforge_sqlalchemy_detector import scan

    return scan.scan(paths, _scan_root)


if __name__ == "__main__":
    try:
        raise SystemExit(serve(PLUGIN_ID, VERSION, _discover))
    except ProtocolError as error:
        print(f"gateforge_sqlalchemy_detector: {error}", file=sys.stderr)
        raise SystemExit(4) from None