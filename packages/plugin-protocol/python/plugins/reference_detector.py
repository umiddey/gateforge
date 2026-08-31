#!/usr/bin/env python3
"""Reference GPP/2 detector: parses trivial `.gfx` route fixtures.

One `METHOD path` per line, `#` comments — the same fixture format and
algorithm as test/fixtures/plugins/_lib.mjs, so both reference plugins
must produce identical resources/findings for identical fixture bytes
(determinism, plan invariant 7). Usage:

    python3 reference_detector.py <fixture-root>

Usage is driven by the TS host tests: host spawns this script, handshakes,
discovers, and shuts it down.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gateforge_plugin import ProtocolError, serve  # noqa: E402

DETECTOR_VERSION = "1.0.0"


def _scan(root: str, rel: str) -> tuple[list[dict], list[dict]]:
    """Scans one .gfx fixture file into (resources, findings).

    Args:
        root: Fixture root directory (plugin argv).
        rel: Repo-root-relative path to scan; rejects absolute/`..` paths.

    Returns:
        tuple[list[dict], list[dict]]: (resources, DUPLICATE_ROUTE findings).

    Raises:
        ValueError: On a non-relative path or a malformed fixture line.
        OSError: If the fixture file does not exist.
    """
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        raise ValueError(f"target must be a relative path under the fixture root, got {rel!r}")
    text = (Path(root) / rel).read_text(encoding="utf-8")
    resources: list[dict] = []
    seen: dict[str, list[dict]] = {}
    for i, line_text in enumerate(text.split("\n")):
        line = line_text.strip()
        if not line or line.startswith("#"):
            continue
        space_at = line.find(" ")
        if space_at <= 0:
            raise ValueError(f"malformed fixture line {i + 1} in {rel}: {line_text!r}")
        method = line[:space_at]
        route_path = line[space_at + 1 :].strip()
        location = {"file": rel, "line": i + 1, "col": 0}
        resources.append(
            {
                "schemaVersion": 1,
                "id": f"web.routes:{method} {route_path}",
                "kind": "http-route",
                "source": rel,
                "location": location,
                "detectorVersion": DETECTOR_VERSION,
                "attributes": {"method": method, "path": route_path},
            }
        )
        seen.setdefault(f"{method} {route_path}", []).append(location)
    findings = [
        {
            "code": "DUPLICATE_ROUTE",
            "detail": f"route '{key}' declared {len(locations)} times",
            "locations": locations,
        }
        for key, locations in sorted(seen.items())
        if len(locations) >= 2
    ]
    return resources, findings


def discover(paths: list[str]) -> dict:
    """GPP/2 discover handler: scans each requested path in order.

    Args:
        paths: Repo-root-relative fixture paths from the discover request.

    Returns:
        dict: {"resources": [...], "unresolved": [], "findings": [...]}.
    """
    resources: list[dict] = []
    findings: list[dict] = []
    for rel in paths:
        file_resources, file_findings = _scan(sys.argv[1] if len(sys.argv) > 1 else ".", rel)
        resources.extend(file_resources)
        findings.extend(file_findings)
    return {"resources": resources, "unresolved": [], "findings": findings}


if __name__ == "__main__":
    try:
        raise SystemExit(serve("python-fixture-detector", DETECTOR_VERSION, discover))
    except ProtocolError as error:
        # Session-fatal: the frame was already emitted; exit nonzero.
        print(f"reference_detector: {error}", file=sys.stderr)
        raise SystemExit(4) from None
