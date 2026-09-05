"""GPP/3 serve entry for the Gateforge FastAPI detector.

Runnable as a module so the CLI's subprocess transport can invoke it with
``python3 -m gateforge_fastapi_detector``: handshake, one lock-step
``discover`` per request, shutdown handshake — all through the reference
client in @gateforge/plugin-protocol (stdlib only).

The module locates the ``gateforge_plugin`` client itself: when it is not
importable from the environment (e.g. only this pack's ``python/`` dir is
on ``PYTHONPATH`` in the monorepo layout), the sibling copy shipped by
``packages/plugin-protocol/python`` is bootstrapped onto ``sys.path``.

Usage:
    python3 -m gateforge_fastapi_detector [root] [--import-roots <json>]
    # root: scan root (default: process cwd, which the CLI sets to the
    #       repo root); every discover path resolves under it.
    # --import-roots: a JSON array of repo-root-relative directories that
    #       act as Python import roots for ABSOLUTE imports (e.g.
    #       '["backend"]' for the central-router-registry pattern). The
    #       TypeScript wrapper passes the ``importRoots`` of
    #       ``.gateforge/fastapi.json`` through this flag. Resolution is
    #       fail-closed: an import matching more than one scanned file
    #       under the roots is a typed unresolved entry, never a guess.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:  # installed / environment-provided client
    from gateforge_plugin import ProtocolError, serve
except ImportError:  # monorepo bootstrap: ../plugin-protocol/python
    _protocol_py = Path(__file__).resolve().parents[3] / "plugin-protocol" / "python"
    sys.path.insert(0, str(_protocol_py))
    from gateforge_plugin import ProtocolError, serve  # noqa: E402

from gateforge_fastapi_detector import PLUGIN_ID, VERSION

_USAGE = (
    "gateforge_fastapi_detector: usage: "
    "python3 -m gateforge_fastapi_detector [root] [--import-roots <json-array>]"
)


def _parse_import_roots(raw: str) -> list[str]:
    """Parses the ``--import-roots`` value: a JSON array of strings."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit(
            f"gateforge_fastapi_detector: --import-roots must be a JSON array "
            f"of repo-relative directories: {error.msg}"
        ) from None
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise SystemExit(
            "gateforge_fastapi_detector: --import-roots must be a JSON array "
            "of repo-relative directories"
        )
    return parsed


_scan_root: Path | None = None
_import_roots: list[str] | None = None

_args = sys.argv[1:]
_index = 0
while _index < len(_args):
    _arg = _args[_index]
    if _arg == "--import-roots":
        _index += 1
        if _index >= len(_args):
            raise SystemExit("gateforge_fastapi_detector: --import-roots requires a JSON array value")
        _import_roots = _parse_import_roots(_args[_index])
    elif _arg.startswith("--import-roots="):
        _import_roots = _parse_import_roots(_arg.split("=", 1)[1])
    elif _arg.startswith("-"):
        raise SystemExit(f"gateforge_fastapi_detector: unknown option {_arg!r}; {_USAGE}")
    elif _scan_root is None:
        _scan_root = Path(_arg).resolve()
    else:
        raise SystemExit(f"gateforge_fastapi_detector: unexpected argument {_arg!r}; {_USAGE}")
    _index += 1


def _discover(paths: list[str]) -> dict:
    """GPP/3 discover handler: scans each repo-relative path in order."""
    from gateforge_fastapi_detector import scan

    return scan.scan(paths, _scan_root, _import_roots)


if __name__ == "__main__":
    try:
        raise SystemExit(serve(PLUGIN_ID, VERSION, _discover))
    except ProtocolError as error:
        print(f"gateforge_fastapi_detector: {error}", file=sys.stderr)
        raise SystemExit(4) from None
