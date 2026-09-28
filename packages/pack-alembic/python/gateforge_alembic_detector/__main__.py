#!/usr/bin/env python3
"""GPP/3 serve entry for the Gateforge Alembic detector.

Usage:
    python3 -m gateforge_alembic_detector [root]
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from gateforge_plugin import ProtocolError, serve
except ImportError:
    _protocol_py = Path(__file__).resolve().parents[3] / "plugin-protocol" / "python"
    sys.path.insert(0, str(_protocol_py))
    from gateforge_plugin import ProtocolError, serve  # noqa: E402

from gateforge_alembic_detector import PLUGIN_ID, VERSION


_scan_root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None


def _discover(paths: list[str]) -> dict:
    """GPP/3 discover handler: scans each repo-relative path in order.

    Args:
        paths (list[str]): List of paths requested for discovery.

    Returns:
        dict: The discovery outcome payload.
    """
    from gateforge_alembic_detector import scan

    return scan.scan(paths, _scan_root)


if __name__ == "__main__":
    try:
        raise SystemExit(serve(PLUGIN_ID, VERSION, _discover))
    except ProtocolError as error:
        print(f"gateforge_alembic_detector: {error}", file=sys.stderr)
        raise SystemExit(4) from None
