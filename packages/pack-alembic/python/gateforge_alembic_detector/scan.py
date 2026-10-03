"""AST-only Alembic revision scanner.

Parses migration scripts with the stdlib ``ast`` module. Never imports
or executes application code. Discovery output matches the GPP/3 result
shape: resources, unresolved, findings, classificationSignals, scannedPaths.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

from gateforge_alembic_detector import PLUGIN_ID, VERSION


def _normalize_path(rel: str) -> str:
    """Validate and normalize a repo-root-relative path.

    Args:
        rel (str): A path from the discover request.

    Returns:
        str: Posix repo-root-relative path.

    Raises:
        ValueError: Absolute paths, empty paths, and ``..`` escapes.
    """
    path = rel.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if path == "" or path.startswith("/") or ".." in path.split("/"):
        raise ValueError(f"target must be a repo-root-relative path, got {rel!r}")
    return path


def _loc(relpath: str, node: ast.AST) -> dict[str, Any]:
    """Build the canonical location triple for an AST node.

    Args:
        relpath (str): Repo-root-relative source path.
        node (ast.AST): Node that carries the fact.

    Returns:
        dict[str, Any]: ``file``, 1-based ``line``, 0-based ``col``.
    """
    line = getattr(node, "lineno", 1) or 1
    col = getattr(node, "col_offset", 0) or 0
    return {"file": relpath, "line": int(line), "col": int(col)}


def _string_or_list(node: ast.AST) -> str | list[str] | None:
    """Read a string literal or a list/tuple of strings.

    Args:
        node (ast.AST): Expression assigned to a revision field.

    Returns:
        str | list[str] | None: The literal, or None when it is not a string.
    """
    if isinstance(node, ast.Constant):
        if node.value is None:
            return None
        if isinstance(node.value, str):
            return node.value
        return None
    if isinstance(node, (ast.List, ast.Tuple)):
        items: list[str] = []
        for elt in node.elts:
            if not isinstance(elt, ast.Constant) or not isinstance(elt.value, str):
                return None
            items.append(elt.value)
        return items
    return None


def _assigned_name(stmt: ast.stmt) -> tuple[str, ast.AST] | None:
    """Return ``(name, value)`` for a simple module assignment.

    Args:
        stmt (ast.stmt): A module-level statement.

    Returns:
        tuple[str, ast.AST] | None: Target name and value, or None.
    """
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
        return stmt.targets[0].id, stmt.value
    if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
        return stmt.target.id, stmt.value
    return None


def _is_noop(body: list[ast.stmt]) -> bool:
    """Whether a function body is only pass, ellipsis, or a docstring.

    Args:
        body (list[ast.stmt]): Function body statements.

    Returns:
        bool: True when the body performs no operation.
    """
    if not body:
        return True
    for stmt in body:
        if isinstance(stmt, ast.Pass):
            continue
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
            if stmt.value.value is Ellipsis or isinstance(stmt.value.value, str):
                continue
        return False
    return True


def _finding(code: str, detail: str, locations: list[dict[str, Any]]) -> dict[str, Any]:
    """One protocol finding.

    Args:
        code (str): Stable finding code.
        detail (str): Single-cause explanation.
        locations (list[dict[str, Any]]): At least one location.

    Returns:
        dict[str, Any]: Finding without host-owned fields.
    """
    return {"code": code, "detail": detail, "locations": locations}


def parse_migration_file(file_path: Path, rel_path: str) -> dict[str, Any] | None:
    """Parse one migration file into revision facts.

    Args:
        file_path (Path): Absolute path to the file.
        rel_path (str): Repo-root-relative path.

    Returns:
        dict[str, Any] | None: Facts, a PARSE_ERROR dict, or None when the
        file is not a revision script.
    """
    try:
        content = file_path.read_text(encoding="utf-8")
        tree = ast.parse(content, filename=rel_path)
    except (OSError, SyntaxError, UnicodeError) as err:
        return {
            "error": "PARSE_ERROR",
            "detail": f"failed to parse migration file {rel_path}: {err}",
            "relPath": rel_path,
            "location": {"file": rel_path, "line": 1, "col": 0},
        }

    revision: str | None = None
    down_revision: str | list[str] | None = None
    revision_node: ast.AST | None = None
    upgrade_fn: ast.FunctionDef | ast.AsyncFunctionDef | None = None
    downgrade_fn: ast.FunctionDef | ast.AsyncFunctionDef | None = None

    for stmt in tree.body:
        assigned = _assigned_name(stmt)
        if assigned is not None:
            name, value = assigned
            if name == "revision":
                extracted = _string_or_list(value)
                if isinstance(extracted, str) and extracted != "":
                    revision = extracted
                    revision_node = stmt
            elif name == "down_revision":
                down_revision = _string_or_list(value)
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if stmt.name == "upgrade":
                upgrade_fn = stmt
            elif stmt.name == "downgrade":
                downgrade_fn = stmt

    if revision is None or revision_node is None:
        return None

    down_revs: list[str] = []
    if isinstance(down_revision, str) and down_revision != "":
        down_revs = [down_revision]
    elif isinstance(down_revision, list):
        down_revs = [item for item in down_revision if item != ""]

    return {
        "revision": revision,
        "downRevisions": down_revs,
        "relPath": rel_path,
        "location": _loc(rel_path, revision_node),
        "upgradeNoop": True if upgrade_fn is None else _is_noop(upgrade_fn.body),
        "downgradeNoop": True if downgrade_fn is None else _is_noop(downgrade_fn.body),
    }


def _safe_name(revision: str) -> str | None:
    """Resource name that does not break plane.name or id:contract grammar.

    Args:
        revision (str): Alembic revision id.

    Returns:
        str | None: A name without ``.`` or ``:``, or None when unsafe.
    """
    if revision == "" or "." in revision or ":" in revision:
        return None
    return revision


def scan(paths: list[str], root: Path | None = None) -> dict[str, Any]:
    """Scan paths for Alembic revision scripts and lineage findings.

    Args:
        paths (list[str]): Repo-root-relative files or directories.
        root (Path | None): Scan root. Defaults to the process cwd.

    Returns:
        dict[str, Any]: GPP/3 discovery outcome. Arrays are sorted.
    """
    base_root = (root if root is not None else Path.cwd()).resolve()
    resources: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    scanned: list[str] = []
    migration_files: list[tuple[Path, str]] = []

    for raw_path in paths:
        try:
            rel = _normalize_path(raw_path)
        except ValueError as err:
            findings.append(
                _finding(
                    "PARSE_ERROR",
                    str(err),
                    [{"file": raw_path.replace("\\", "/") or raw_path, "line": 1, "col": 0}],
                )
            )
            continue
        candidate = (base_root / rel).resolve()
        try:
            candidate.relative_to(base_root)
        except ValueError:
            findings.append(
                _finding(
                    "PARSE_ERROR",
                    f"target must be a repo-root-relative path, got {raw_path!r}",
                    [{"file": rel, "line": 1, "col": 0}],
                )
            )
            continue
        if candidate.is_file() and candidate.suffix == ".py":
            migration_files.append((candidate, rel))
        elif candidate.is_dir():
            for path in sorted(candidate.rglob("*.py")):
                if path.name.startswith("__"):
                    continue
                rel_file = path.resolve().relative_to(base_root).as_posix()
                migration_files.append((path, rel_file))

    revisions: dict[str, dict[str, Any]] = {}
    for file_path, rel_path in migration_files:
        scanned.append(rel_path)
        facts = parse_migration_file(file_path, rel_path)
        if facts is None:
            continue
        if "error" in facts:
            findings.append(_finding(str(facts["error"]), str(facts["detail"]), [facts["location"]]))
            continue
        rev = str(facts["revision"])
        if rev in revisions:
            findings.append(
                _finding(
                    "DUPLICATE_REVISION_ID",
                    f"duplicate revision '{rev}' in {rel_path} and {revisions[rev]['relPath']}",
                    [facts["location"], revisions[rev]["location"]],
                )
            )
            continue
        revisions[rev] = facts

    for rev, facts in revisions.items():
        for parent in facts["downRevisions"]:
            if parent not in revisions:
                findings.append(
                    _finding(
                        "DANGLING_DOWN_REVISION",
                        f"migration '{rev}' in {facts['relPath']} references missing parent '{parent}'",
                        [facts["location"]],
                    )
                )

    children: dict[str, list[str]] = {rev: [] for rev in revisions}
    for rev, facts in revisions.items():
        for parent in facts["downRevisions"]:
            if parent in children:
                children[parent].append(rev)
    heads = sorted(rev for rev, kids in children.items() if len(kids) == 0)
    if len(heads) > 1:
        named = ", ".join(f"'{head}' ({revisions[head]['relPath']})" for head in heads)
        findings.append(
            _finding(
                "MULTIPLE_MIGRATION_HEADS",
                f"multiple migration heads: {named}",
                [revisions[head]["location"] for head in heads],
            )
        )

    for rev in sorted(revisions):
        facts = revisions[rev]
        safe = _safe_name(rev)
        if safe is None:
            unresolved.append(
                {
                    "code": "UNSAFE_REVISION_ID",
                    "detail": f"revision '{rev}' contains '.' or ':' and cannot be a resource name",
                    "location": facts["location"],
                }
            )
            continue
        resources.append(
            {
                "schemaVersion": 1,
                "id": f"alembic-migration-{safe}",
                "kind": "alembic.migration",
                "source": facts["relPath"],
                "location": facts["location"],
                "detectorVersion": VERSION,
                "attributes": {
                    "resourceName": safe,
                    "revision": rev,
                    "downRevisions": facts["downRevisions"],
                    "isHead": rev in heads,
                    "downgradeNoop": facts["downgradeNoop"],
                    "upgradeNoop": facts["upgradeNoop"],
                    "detectorId": PLUGIN_ID,
                },
            }
        )

    if revisions:
        head = heads[0] if len(heads) == 1 else None
        source = revisions[heads[0]]["relPath"] if heads else next(iter(revisions.values()))["relPath"]
        location = revisions[heads[0]]["location"] if heads else next(iter(revisions.values()))["location"]
        resources.append(
            {
                "schemaVersion": 1,
                "id": "alembic-chain-default",
                "kind": "alembic.chain",
                "source": source,
                "location": location,
                "detectorVersion": VERSION,
                "attributes": {
                    "resourceName": "alembic-chain",
                    "heads": heads,
                    "head": head,
                    "revisionCount": len(revisions),
                    "revisions": sorted(revisions),
                    "files": sorted(facts["relPath"] for facts in revisions.values()),
                },
            }
        )

    resources.sort(key=lambda item: (str(item["kind"]), str(item["id"])))
    findings.sort(key=lambda item: (item["code"], item["detail"], item["locations"][0]["file"]))
    unresolved.sort(key=lambda item: (item["code"], item["location"]["file"], item["detail"]))
    return {
        "resources": resources,
        "unresolved": unresolved,
        "findings": findings,
        "classificationSignals": [],
        "scannedPaths": sorted(set(scanned)),
    }


def main() -> None:
    """Print one discovery document for a root and repo-relative paths.

    Returns:
        None: Writes JSON to stdout. ``sys.argv`` is root, then paths.
    """
    import json
    import sys

    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    paths = sys.argv[2:] if len(sys.argv) > 2 else ["."]
    json.dump(scan(paths, root), sys.stdout)


if __name__ == "__main__":
    main()
