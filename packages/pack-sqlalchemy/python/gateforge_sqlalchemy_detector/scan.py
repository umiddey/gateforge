"""Gateforge SQLAlchemy discovery core (AST only, stdlib only).

Lineage: spikes/discovery/discover.py (Phase 0 spike) adapted to the
canonical detector vocabulary of the frozen resource graph:
- resources carry ``schemaVersion``/``id``/``kind``/``source``/
  ``location``/``detectorVersion``/``attributes`` and use
  ``attributes["resourceName"]`` as the graph identity attribute;
- table-candidate classes are ALSO emitted as ``gateforge.class``
  symbols so the graph's repo-wide symbol table can resolve inherited
  tablenames across files (spike limitation 1 fixed by the graph);
- computed names (GF-21) are typed ``unresolved`` entries located at
  the class statement -- never absent, never guessed (ADR 0001 D1);
- duplicate table names (GF-20) and repeated class names (GF-01) are
  findings; malformed files (GF-19) are ``PARSE_ERROR`` findings.
"""

from __future__ import annotations

import ast
from pathlib import Path

from . import VERSION

TABULAR_ATTR = "__tablename__"
ABSTRACT_ATTR = "__abstract__"
TABLE_ARGS_ATTR = "__table_args__"


def expr_label(node: ast.expr) -> str:
    """Classify a non-literal expression deterministically for UNRESOLVED reasons.

    Args:
        node: The AST expression to classify.

    Returns:
        str: A stable machine-readable label (never the unparsed source
            of a nested decorator chain, which may be huge or truncated).
    """
    if isinstance(node, ast.Constant):
        return f"constant:{type(node.value).__name__}"
    if isinstance(node, ast.JoinedStr):
        return "f-string"
    if isinstance(node, ast.Name):
        return f"name:{node.id}"
    if isinstance(node, ast.Attribute):
        return f"attribute:{ast.unparse(node)[:80]}"
    if isinstance(node, ast.Call):
        return f"call:{ast.unparse(node.func)[:80]}"
    if isinstance(node, ast.BinOp):
        return f"binop:{ast.unparse(node)[:80]}"
    if isinstance(node, ast.IfExp):
        return "conditional"
    return f"expr:{type(node).__name__}"


def call_name(func: ast.expr) -> str | None:
    """Simple name of a call's callable, for Name and Attribute forms.

    Args:
        func: The callable expression of a Call node.

    Returns:
        str | None: The simple (last-segment) name, or None.
    """
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def base_name(node: ast.expr) -> str | None:
    """Derivable simple name of a base-class expression.

    Args:
        node: One base expression of a ClassDef.

    Returns:
        str | None: The simple name, or None when not derivable.
    """
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


class ClassRecord:
    """AST facts about one class definition, at any lexical scope."""

    def __init__(self, qname: str, node: ast.ClassDef, scope: str):
        self.qname = qname
        self.node = node
        self.scope = scope  # "" at module level, enclosing dotted scope otherwise
        self.bases: list[str] = [b for b in (base_name(b) for b in node.bases) if b is not None]
        self.keywords = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        self.tablename_literal: str | None = None
        self.tablename_expr: ast.expr | None = None
        self.tablename_func: ast.FunctionDef | ast.AsyncFunctionDef | None = None
        self.abstract: bool = False
        self.has_table_args: bool = False
        self.table_args_schema: str | None = None
        self._scan_body()

    def _scan_body(self) -> None:
        for stmt in self.node.body:
            if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                targets = (
                    stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                )
                names = [t.id for t in targets if isinstance(t, ast.Name)]
                value = stmt.value
                if TABULAR_ATTR in names and self.tablename_expr is None:
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        self.tablename_literal = value.value
                    else:
                        self.tablename_expr = value
                if ABSTRACT_ATTR in names and isinstance(value, ast.Constant) and value.value is True:
                    self.abstract = True
                if TABLE_ARGS_ATTR in names:
                    self.has_table_args = True
                    if isinstance(value, ast.Dict):
                        for k, v in zip(value.keys, value.values):
                            if (
                                isinstance(k, ast.Constant)
                                and k.value == "schema"
                                and isinstance(v, ast.Constant)
                                and isinstance(v.value, str)
                            ):
                                self.table_args_schema = v.value
            elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == TABULAR_ATTR:
                self.tablename_func = stmt

    # -- Classification ----------------------------------------------------

    def is_pure_base(self, idx: "FileIndex") -> bool:
        """Abstract bases, and DeclarativeBase subclasses that declare no table facts."""
        if self.abstract:
            return True
        no_table_facts = (
            self.tablename_literal is None
            and self.tablename_expr is None
            and self.tablename_func is None
        )
        return no_table_facts and any(b == "DeclarativeBase" for b in self.bases)

    def is_table_candidate(self) -> bool:
        """Has table facts, or is declarative-style (bases) with none."""
        has_facts = (
            self.tablename_literal is not None
            or self.tablename_expr is not None
            or self.tablename_func is not None
            or "table" in self.keywords
        )
        return has_facts or bool(self.bases)


class FileIndex:
    """One parsed file plus every detector fact gathered from it."""

    def __init__(self, relpath: str, tree: ast.Module):
        self.relpath = relpath
        self.classes: list[ClassRecord] = []
        self.table_calls: list[dict] = []  # {table_name, target, node}
        self.declarative_base_aliases: set[str] = set()
        self._collect(tree)

    def _collect(self, tree: ast.Module) -> None:
        assigned_call_nodes: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                target = (
                    node.targets[0].id
                    if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                    else None
                )
                if isinstance(node.value, ast.Call):
                    fname = call_name(node.value.func)
                    if fname == "declarative_base" and target:
                        self.declarative_base_aliases.add(target)
                    if fname == "Table" and self._literal_name_arg(node.value):
                        self.table_calls.append(
                            {
                                "table_name": node.value.args[0].value,
                                "target": target or f"__anonymous_table_at_line_{node.lineno}",
                                "node": node.value,
                            }
                        )
                        assigned_call_nodes.add(id(node.value))
            elif isinstance(node, ast.Call) and id(node) not in assigned_call_nodes:
                if call_name(node.func) == "Table" and self._literal_name_arg(node):
                    self.table_calls.append(
                        {
                            "table_name": node.args[0].value,
                            "target": f"__anonymous_table_at_line_{node.lineno}",
                            "node": node,
                        }
                    )
        self._collect_classes(tree)

    @staticmethod
    def _literal_name_arg(call: ast.Call) -> bool:
        return bool(call.args) and isinstance(call.args[0], ast.Constant) and isinstance(
            call.args[0].value, str
        )

    def _collect_classes(self, tree: ast.Module) -> None:
        def visit(node: ast.AST, stack: list[str]) -> None:
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    visit(child, stack + [child.name])
                elif isinstance(child, ast.ClassDef):
                    qname = ".".join(stack + [child.name])
                    self.classes.append(ClassRecord(qname, child, ".".join(stack)))
                    visit(child, stack + [child.name])
                else:
                    visit(child, stack)

        visit(tree, [])


def loc(relpath: str, node: ast.AST) -> dict:
    """Build the canonical location triple for an AST node.

    Args:
        relpath: Repo-root-relative source path.
        node: The AST node.

    Returns:
        dict: {"file", "line", "col"} with 1-based line and 0-based col.
    """
    return {"file": relpath, "line": node.lineno, "col": node.col_offset}


def _symbol_resource(relpath: str, rec: ClassRecord, name_unresolved: bool) -> dict:
    """The graph class-symbol resource for one declarative class.

    Args:
        relpath: Repo-root-relative source path.
        rec: The class record.
        name_unresolved: Detector assertion that this class's tablename is
            unresolved (true for table candidates the detector cannot name;
            false for pure bases and literal-named classes).

    Returns:
        dict: A ``gateforge.class`` resource consumed by the symbol table.
    """
    attrs: dict = {
        "qname": rec.qname,
        "resourceKind": "sqlalchemy.table",
        "abstract": rec.abstract,
        "tablenameUnresolved": name_unresolved,
    }
    if rec.bases:
        attrs["baseNames"] = list(rec.bases)
    if rec.tablename_literal is not None:
        attrs["tableName"] = rec.tablename_literal
    return {
        "schemaVersion": 1,
        "id": f"sqlalchemy.class:{relpath}:{rec.qname}",
        "kind": "gateforge.class",
        "source": relpath,
        "location": loc(relpath, rec.node),
        "detectorVersion": VERSION,
        "attributes": attrs,
    }


def _table_resource(relpath: str, rec: ClassRecord, provenance: str) -> dict:
    """The business table resource for a class with a literal tablename.

    Args:
        relpath: Repo-root-relative source path.
        rec: The class record.
        provenance: Tablename provenance label (always ``literal`` here).

    Returns:
        dict: A ``sqlalchemy.table`` resource.
    """
    return {
        "schemaVersion": 1,
        "id": f"sqlalchemy.table:{relpath}:{rec.qname}",
        "kind": "sqlalchemy.table",
        "source": relpath,
        "location": loc(relpath, rec.node),
        "detectorVersion": VERSION,
        "attributes": {
            "resourceName": rec.tablename_literal,
            "classQname": rec.qname,
            "scope": rec.scope or "module",
            "tableName": rec.tablename_literal,
            "tablenameProvenance": provenance,
            "hasTableArgs": rec.has_table_args,
            "tableArgsSchema": rec.table_args_schema,
            "tableKeywordTrue": "table" in rec.keywords,
            "abstract": False,
            "baseNames": list(rec.bases),
        },
    }


def _call_table_resource(relpath: str, call: dict) -> dict:
    """The business table resource for a direct ``Table("name", ...)`` call.

    Args:
        relpath: Repo-root-relative source path.
        call: The recorded Table-call facts.

    Returns:
        dict: A ``sqlalchemy.table`` resource.
    """
    return {
        "schemaVersion": 1,
        "id": f"sqlalchemy.table:{relpath}:{call['target']}",
        "kind": "sqlalchemy.table",
        "source": relpath,
        "location": loc(relpath, call["node"]),
        "detectorVersion": VERSION,
        "attributes": {
            "resourceName": call["table_name"],
            "tableName": call["table_name"],
            "tablenameProvenance": "table-call-first-arg",
            "hasTableArgs": False,
            "tableArgsSchema": None,
            "tableKeywordTrue": False,
            "abstract": False,
            "baseNames": [],
        },
    }


def _computed_reason(rec: ClassRecord) -> str:
    """The single-cause reason for a class whose tablename is not literal.

    Args:
        rec: The class record.

    Returns:
        str: A machine-readable (code, reason) explanation, never truncated.
    """
    if rec.tablename_func is not None:
        fn = rec.tablename_func
        ret = fn.body[0].value if fn.body and isinstance(fn.body[0], ast.Return) else None
        return (
            f"computed_tablename: decorated function "
            f"({len(fn.decorator_list)} decorator(s)); "
            f"returns {expr_label(ret) if ret else 'unknown'}"
        )
    if rec.tablename_expr is not None:
        return f"computed_tablename: assigned from {expr_label(rec.tablename_expr)}"
    if "table" in rec.keywords:
        return (
            "table_name_derived_runtime: class keyword table=True marks a "
            "table but the name is derived by the framework from the class "
            "name at runtime, not visible in the AST"
        )
    return (
        "no_tablename_source: declarative-style class with bases "
        f"{rec.bases} but no __tablename__ in the class or any resolvable "
        "base chain"
    )


def _unresolved_entry(relpath: str, rec: ClassRecord) -> dict:
    """A typed unresolved entry located at the class statement.

    Args:
        relpath: Repo-root-relative source path.
        rec: The class record.

    Returns:
        dict: The canonical unresolved-reason shape; the location points
            at the class so the graph can retire it when it resolves the
            name via the symbol table.
    """
    reason = _computed_reason(rec)
    code = reason.split(":", 1)[0]
    return {
        "code": code,
        "detail": reason,
        "location": loc(relpath, rec.node),
    }


def _duplicate_findings(resources: list[dict]) -> list[dict]:
    """Duplicate table names (GF-20): same name in 2 files or twice in 1.

    Args:
        resources: The business table resources of one discovery request.

    Returns:
        list[dict]: One finding per duplicated table name, locations sorted.
    """
    by_table: dict[str, list[dict]] = {}
    for r in resources:
        if r["kind"] == "sqlalchemy.table" and r["attributes"].get("resourceName"):
            by_table.setdefault(r["attributes"]["resourceName"], []).append(r)
    findings: list[dict] = []
    for table_name in sorted(by_table):
        group = by_table[table_name]
        if len(group) < 2:
            continue
        sorted_group = sorted(
            group,
            key=lambda g: (g["location"]["file"], g["location"]["line"], g["location"]["col"], g["id"]),
        )
        locations = [
            {"file": g["location"]["file"], "line": g["location"]["line"], "col": g["location"]["col"]}
            for g in sorted_group
        ]
        files = sorted({l["file"] for l in locations})
        qnames = [g["attributes"].get("classQname") for g in sorted_group]
        qnames = [q for q in qnames if q is not None]
        detail = (
            f"table '{table_name}' declared {len(group)} times across "
            f"{len(files)} file(s)"
        )
        if qnames:
            detail += f" (declarations: {', '.join(qnames)})"
        findings.append(
            {
                "code": "DUPLICATE_TABLE_NAME",
                "detail": detail,
                "locations": locations,
            }
        )
    return findings


def _class_name_findings(indexes: dict[str, FileIndex]) -> list[dict]:
    """Repeated class names in one file (GF-01): non-collapse proof.

    Args:
        indexes: Parsed-file indexes of one discovery request.

    Returns:
        list[dict]: One finding per repeated simple class name per file.
    """
    findings: list[dict] = []
    for relpath in sorted(indexes):
        by_simple: dict[str, list[ClassRecord]] = {}
        for rec in indexes[relpath].classes:
            by_simple.setdefault(rec.qname.split(".")[-1], []).append(rec)
        for simple in sorted(by_simple):
            group = by_simple[simple]
            if len(group) < 2:
                continue
            qnames = sorted(rec.qname for rec in group)
            locations = [
                loc(relpath, rec.node) for rec in sorted(
                    group, key=lambda r: (r.node.lineno, r.node.col_offset)
                )
            ]
            findings.append(
                {
                    "code": "CLASS_NAME_REPEATED_IN_FILE",
                    "detail": (
                        f"class name '{simple}' occurs in {len(group)} distinct "
                        f"scopes; kept as distinct resources: {qnames}"
                    ),
                    "locations": locations,
                }
            )
    return findings


def _parse_error_finding(relpath: str, exc: BaseException) -> dict:
    """The GF-19 PARSE_ERROR finding for one malformed file.

    Args:
        relpath: Repo-root-relative source path.
        exc: The SyntaxError/ValueError/UnicodeDecodeError raised.

    Returns:
        dict: Canonical finding with a 1-based line and single-cause detail.
    """
    line = getattr(exc, "lineno", 0) or 0
    msg = exc.msg if isinstance(exc, SyntaxError) else str(exc)
    return {
        "code": "PARSE_ERROR",
        "detail": f"{type(exc).__name__}: {msg}",
        "locations": [{"file": relpath, "line": max(line, 1), "col": 0}],
    }


def _scan_file(relpath: str, root: Path) -> tuple[FileIndex | None, dict | None]:
    """Parse one repo-relative file into its index, or a PARSE_ERROR finding.

    Args:
        relpath: Repo-root-relative posix path (validated by caller).
        root: The scan root (process cwd by default).

    Returns:
        tuple: (index or None, finding or None) — exactly one is set.
    """
    text = (root / relpath).read_text(encoding="utf-8")
    try:
        tree = ast.parse(text, filename=relpath)
    except (SyntaxError, ValueError, UnicodeDecodeError) as exc:
        return None, _parse_error_finding(relpath, exc)
    return FileIndex(relpath, tree), None


def _normalize_path(rel: str) -> str:
    """Validate + normalize a repo-root-relative path.

    Args:
        rel: A path from the discover request.

    Returns:
        str: Posix repo-root-relative path (`./` stripped, backslashes → `/`).

    Raises:
        ValueError: Non-relative paths (absolute, drive-qualified, `..`
            escaping, empty) are rejected fail-closed.
    """
    path = rel.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if path == "":
        raise ValueError(f"target must be a repo-root-relative path, got {rel!r}")
    if path.startswith("/"):
        raise ValueError(f"target must be a repo-root-relative path, got {rel!r}")
    if ".." in path.split("/"):
        raise ValueError(f"target must be a repo-root-relative path, got {rel!r}")
    return path


def scan(paths: list[str], root: Path | None = None) -> dict:
    """Collect the full deterministic discovery outcome for one request.

    Args:
        paths: Repo-root-relative paths from the discover request.
        root: Scan root directory (defaults to the process cwd, which the
            CLI sets to the repo root).

    Returns:
        dict: {"resources": [...], "unresolved": [...], "findings": [...]}
            with every array deterministically sorted.

    Raises:
        OSError: A scanned file is missing/unreadable — surfaced as a
            plugin error frame by the serve loop (fail closed).
    """
    base = root if root is not None else Path.cwd()
    relpaths = [_normalize_path(p) for p in paths]

    indexes: dict[str, FileIndex] = {}
    findings: list[dict] = []
    for relpath in relpaths:
        index, finding = _scan_file(relpath, base)
        if finding is not None:
            findings.append(finding)
            continue
        indexes[relpath] = index

    resources: list[dict] = []
    unresolved: list[dict] = []

    # Pass 1: class symbols + business tables + typed unresolved.
    for relpath in sorted(indexes):
        idx = indexes[relpath]
        for rec in idx.classes:
            if rec.is_table_candidate() or rec.is_pure_base(idx):
                last_segment_unresolved = (
                    rec.tablename_literal is None and not rec.is_pure_base(idx)
                )
                resources.append(_symbol_resource(relpath, rec, last_segment_unresolved))
            if rec.is_pure_base(idx):
                continue  # bases never materialize; the symbol table owns them
            if rec.tablename_literal is not None:
                resources.append(_table_resource(relpath, rec, "literal"))
            elif rec.is_table_candidate():
                unresolved.append(_unresolved_entry(relpath, rec))

    # Pass 2: direct Table("name", ...) declarations.
    for relpath in sorted(indexes):
        for call in indexes[relpath].table_calls:
            resources.append(_call_table_resource(relpath, call))

    resources.sort(key=lambda r: r["id"])
    unresolved.sort(
        key=lambda u: (
            u["location"]["file"], u["location"]["line"],
            u["location"]["col"], u["code"], u["detail"],
        )
    )
    findings.extend(_duplicate_findings(resources))
    findings.extend(_class_name_findings(indexes))
    findings.sort(
        key=lambda f: (
            f["code"], f["detail"],
            f["locations"][0]["file"] if f["locations"] else "",
            f["locations"][0]["line"] if f["locations"] else 0,
        )
    )

    return {"resources": resources, "unresolved": unresolved, "findings": findings}