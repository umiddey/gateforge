"""Gateforge SQLAlchemy discovery core (AST only, stdlib only).

Lineage: spikes/discovery/discover.py (Phase 0 spike) adapted to the
canonical detector vocabulary of the frozen resource graph:
- resources carry ``schemaVersion``/``id``/``kind``/``source``/
  ``location``/``detectorVersion``/``attributes`` and use
  ``attributes["resourceName"]`` as the graph identity attribute;
- TABLE-CANDIDATE classes are ALSO emitted as ``gateforge.class``
  symbols so the graph's repo-wide symbol table can resolve inherited
  tablenames across files (spike limitation 1 fixed by the graph);
- computed names (GF-21) are typed ``unresolved`` entries located at
  the class statement -- never absent, never guessed (ADR 0001 D1);
- duplicate table names (GF-20) and repeated class names (GF-01) are
  findings; malformed files (GF-19) are ``PARSE_ERROR`` findings.
  GF-20 is BASE-QUALIFIED (detector 0.2.0): a same ``__tablename__``
  group is flagged unless every pair of declarations provably sits on
  a DIFFERENT declarative Base root (distinct ``MetaData`` at
  runtime). Base roots resolve through local alias chains and through
  imports into scanned files; anything unprovable (unresolvable import,
  ``Table("name", ...)`` calls, mixed evidence) stays flagged —
  fail closed. Same name on different planes was never the detector's
  call: plane qualification owns identity collapse (the graph's
  ``detectDuplicateIds``).

Classification signals (plan phase 3, ADR 0003 D1): the detector emits
code-derived FACTS, never classifications and never exposure claims:

- ``identity`` signals carry the ORDERED primary-key columns (simple
  and composite; declaration order preserved) derived from
  ``Column(primary_key=True)``/``mapped_column(primary_key=True)`` or a
  literal ``PrimaryKeyConstraint``. A table whose key is computed or
  not visible in the class gets a typed ``PRIMARY_KEY_UNRESOLVED``
  unresolved entry instead — the key is never defaulted to ``id``;
- ``delete-semantics``/``archive-state`` declaration signals are
  emitted only from the machine-readable class declarations
  ``__gateforge_delete_semantics__ = "hard"|"archive"`` and
  ``__gateforge_archive_state__ = {<field>: <literal value>}``;
  a non-literal archive declaration becomes ``ARCHIVE_STATE_UNRESOLVED``.
  Column NAMES resembling soft-delete bookkeeping are reported as the
  ``softDeleteCandidateFields`` attribute (a fact for reviewers), never
  as semantics;
- ``__gateforge_read_only__ = True`` emits ``lifecycle.*`` declaration
  signals asserting the operation unsupported (an assertion the core
  classifier consumes conservatively — never a suppression on its own);
- ``foreignKeyReferences`` facts (column → ``<table>.<column>``) ride
  the resource attributes for cross-artifact linkage.

No exposure signal is ever emitted from a table declaration alone
(plan phase 3 guard): exposure needs externally reachable evidence,
which only linkage detectors may provide.

Table-candidate recognition (phase 2, detector precision): a class is a
table candidate iff it carries explicit table facts (literal/computed
``__tablename__`` or ``table=True``) OR one of its bases statically
resolves to a SQLAlchemy declarative base. "Resolves" is deliberately
CONSERVATIVE — a flat file scan cannot import anything, so a base name
is declarative only when it is the conventional name ``Base`` (exact;
``BaseModel``/``BaseSettings``/``BaseException`` never match), the
literal ``DeclarativeBase``, a locally registered declarative alias
(``X = declarative_base()``, ``X = <alias>.declarative_base()``,
``X = registry().generate_base()``, ``class X(DeclarativeBase)``), or
the simple name of an already-detected model class (inheritance closure
applied to a fixpoint, so multi-level chains resolve across files).
The closure is bounded by LOCAL DEFINITION EVIDENCE: when the same file
defines a class with that simple name whose own base is denylisted (a
Pydantic ``class WebhookEvent(BaseModel)`` shadowing a genuine
``class WebhookEvent(Base)`` in a models module), the closure must not
claim it — or any local subclass beneath it.
Base names whose import provenance is a known NON-ORM module family
(``pydantic``, ``abc``, ``enum``, ``argparse``, ``dataclasses``,
``marshmallow``, ``fastapi``) can never make a class a candidate — this
kills pathological aliasing like ``from pydantic import BaseModel as
Base``, which in a real dogfood produced ~1,100 false-positive blocking
entries from Pydantic schema directories alone. A class that is not a
candidate is emitted NOWHERE — no symbol, no table, no unresolved
entry: silence for non-models is the point of the predicate, while
genuine candidates keep every typed escape hatch (``__abstract__``,
computed names, pure bases).
"""

from __future__ import annotations

import ast
import json
from dataclasses import dataclass
from pathlib import Path

from . import PLUGIN_ID, VERSION

TABULAR_ATTR = "__tablename__"
ABSTRACT_ATTR = "__abstract__"
TABLE_ARGS_ATTR = "__table_args__"

# Machine-readable source declarations this detector recognizes (plan
# phase 3). Declarations are assertions consumed by the core classifier —
# contradictory code signals still block (ADR 0003 D5).
DELETE_SEMANTICS_ATTR = "__gateforge_delete_semantics__"
ARCHIVE_STATE_ATTR = "__gateforge_archive_state__"
READ_ONLY_ATTR = "__gateforge_read_only__"
UPDATEABLE_FIELDS_ATTR = "__gateforge_updateable_fields__"

# Column-call constructors carrying column facts.
COLUMN_CALL_NAMES = ("Column", "mapped_column")

# Import provenance that can NEVER make a base name a declarative root
# (phase 2 denylist). The conventional-name rule ("Base") is a flat-file
# heuristic: most projects do ``from app.db import Base`` (cross-file,
# statically unresolvable here), but the SAME spelling is reachable
# through aliasing — ``from pydantic import BaseModel as Base`` — and a
# false positive is a BLOCKING finding in a closed-world gate. Root
# module matching (``pydantic`` covers ``pydantic.*``) is fail-closed in
# the anti-false-positive direction: an ORM base legitimately imported
# from one of these families does not exist in practice.
DENYLISTED_BASE_MODULES = (
    "pydantic",
    "abc",
    "enum",
    "argparse",
    "dataclasses",
    "marshmallow",
    "fastapi",
)

# Column names that RESEMBLE soft-delete bookkeeping. Facts for
# reviewers (attribute only) — never delete semantics, which must be
# proven by a declaration or by the core classifier's lattice.
SOFT_DELETE_CANDIDATE_FIELDS = (
    "archived",
    "archived_at",
    "deleted",
    "deleted_at",
    "is_deleted",
)


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


@dataclass
class ImportRef:
    """One import binding usable for base-name provenance (phase 2).

    Attributes:
        module: The dotted source module (absolute portion; ``""`` for a
            bare relative ``from . import x``). ``None``-free on purpose:
            provenance decisions must see "no module" as an empty string.
        name: The imported top-level name (``None`` when the binding is a
            module alias from a plain ``import a.b``).
        level: Relative-import depth (0: absolute).
    """

    module: str
    name: str | None
    level: int


def module_denied(module: str | None) -> bool:
    """Whether an import source module is on the base-provenance denylist.

    Args:
        module: The dotted module of the import (``None``/``""`` = not
            knowable, e.g. a relative import — never denied).

    Returns:
        bool: True when the module's ROOT is a known non-ORM family, so a
            base bound from it can never make its class a table candidate.
    """
    if not module:
        return False
    return module.split(".")[0] in DENYLISTED_BASE_MODULES


class ColumnFacts:
    """Column-level facts extracted from one model's AST, in written order.

    Attributes of a table the detector can SEE statically. Anything not
    provable here is reported unresolved (never defaulted, never guessed).
    """

    def __init__(self) -> None:
        #: Ordered literal primary-key column names (simple + composite).
        self.primary_key_columns: list[str] = []
        #: True when a primary_key argument exists but is not the literal True.
        self.has_computed_pk_arg: bool = False
        #: True when PrimaryKeyConstraint literal columns were found.
        self.has_pk_constraint: bool = False
        #: {column: "<table>.<column>"} literal ForeignKey references.
        self.foreign_keys: dict[str, str] = {}
        #: Sorted column names resembling soft-delete bookkeeping.
        self.soft_delete_candidates: list[str] = []

    @property
    def has_pk_evidence(self) -> bool:
        """Whether any literal primary-key evidence was found."""
        return bool(self.primary_key_columns)


def _literal_kwarg_true(call: ast.Call, name: str) -> bool | None:
    """Reads a keyword flag of a call as True/False/None (non-literal).

    Args:
        call: The call node.
        name: Keyword name.

    Returns:
        bool | None: The literal truth value, or None when absent or
            non-literal (the caller must treat None as unproven).
    """
    for kw in call.keywords:
        if kw.arg == name:
            if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, bool):
                return kw.value.value
            return None
    return None


def _column_call_name(call: ast.expr) -> str | None:
    """Simple name of a call, when it is a column constructor."""
    name = call_name(call.func) if isinstance(call, ast.Call) else None
    return name if name in COLUMN_CALL_NAMES else None


def _column_name(call: ast.Call, target: str | None) -> str | None:
    """Derives a column's name: literal first arg wins, else the target.

    Args:
        call: The column constructor call.
        target: Assignment target name (or None).

    Returns:
        str | None: The column name, or None when neither source is literal.
    """
    if call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
        return call.args[0].value
    return target


def _foreign_key_reference(call: ast.Call) -> str | None:
    """Finds a literal ``ForeignKey("<table>.<column>")`` argument."""
    for arg in call.args:
        if (
            isinstance(arg, ast.Call)
            and call_name(arg.func) == "ForeignKey"
            and arg.args
            and isinstance(arg.args[0], ast.Constant)
            and isinstance(arg.args[0].value, str)
        ):
            return arg.args[0].value
    for kw in call.keywords:
        if (
            isinstance(kw.value, ast.Call)
            and call_name(kw.value.func) == "ForeignKey"
            and kw.value.args
            and isinstance(kw.value.args[0], ast.Constant)
            and isinstance(kw.value.args[0].value, str)
        ):
            return kw.value.args[0].value
    return None


def _record_column(facts: ColumnFacts, call: ast.Call, target: str | None) -> None:
    """Records one column-constructor call's facts into `facts`.

    Args:
        facts: Accumulating facts.
        call: The column constructor call.
        target: Assignment target name (or None for positional columns).
    """
    column_name = _column_name(call, target)
    primary_key = _literal_kwarg_true(call, "primary_key")
    if primary_key is None and any(kw.arg == "primary_key" for kw in call.keywords):
        # A primary_key argument exists but is computed (GF-21 mechanic
        # for keys): remember the hole — never guess the key.
        facts.has_computed_pk_arg = True
    if primary_key is True and column_name is not None:
        facts.primary_key_columns.append(column_name)
    if column_name is not None:
        reference = _foreign_key_reference(call)
        if reference is not None:
            facts.foreign_keys[column_name] = reference
        if column_name in SOFT_DELETE_CANDIDATE_FIELDS:
            facts.soft_delete_candidates.append(column_name)


def _facts_from_column_calls(calls: list[tuple[ast.Call, str | None]]) -> ColumnFacts:
    """Builds ColumnFacts from (call, target) pairs in written order."""
    facts = ColumnFacts()
    for call, target in calls:
        _record_column(facts, call, target)
    return facts


def _pk_constraint_columns(node: ast.expr) -> list[str] | None:
    """Literal ordered columns of a ``PrimaryKeyConstraint("a", "b")``.

    Args:
        node: An ``__table_args__`` tuple element.

    Returns:
        list[str] | None: The ordered literal columns, or None when the
            node is not a PrimaryKeyConstraint with literal args.
    """
    if (
        isinstance(node, ast.Call)
        and call_name(node.func) == "PrimaryKeyConstraint"
        and node.args
        and all(
            isinstance(a, ast.Constant) and isinstance(a.value, str) for a in node.args
        )
    ):
        return [a.value for a in node.args if isinstance(a.value, str)]
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
        # Machine-readable source declarations (phase 3), None when absent.
        self.delete_semantics_literal: str | None = None
        self.delete_semantics_expr: ast.expr | None = None
        self.archive_state_literal: dict[str, str | int | float | bool] | None = None
        self.archive_state_expr: ast.expr | None = None
        self.read_only: bool = False
        self.updateable_fields_literal: list[str] | None = None
        # Column-level facts, in written order (body first, then table args).
        self.column_facts: ColumnFacts = ColumnFacts()
        self._scan_body()

    def _scan_body(self) -> None:
        column_calls: list[tuple[ast.Call, str | None]] = []
        table_args_node: ast.expr | None = None
        for stmt in self.node.body:
            if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                targets = (
                    stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                )
                names = [t.id for t in targets if isinstance(t, ast.Name)]
                value = stmt.value
                if value is not None and isinstance(value, ast.Call) and _column_call_name(value) is not None:
                    for name in names:
                        column_calls.append((value, name))
                if TABULAR_ATTR in names and self.tablename_expr is None:
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        self.tablename_literal = value.value
                    elif value is not None:
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
                    elif value is not None:
                        table_args_node = value
                if DELETE_SEMANTICS_ATTR in names and value is not None:
                    if isinstance(value, ast.Constant) and value.value in ("hard", "archive"):
                        self.delete_semantics_literal = value.value
                    else:
                        self.delete_semantics_expr = value
                if ARCHIVE_STATE_ATTR in names and value is not None:
                    self.archive_state_literal = _literal_record(value)
                    if self.archive_state_literal is None:
                        self.archive_state_expr = value
                if READ_ONLY_ATTR in names and isinstance(value, ast.Constant) and value.value is True:
                    self.read_only = True
                if UPDATEABLE_FIELDS_ATTR in names and value is not None:
                    self.updateable_fields_literal = _string_sequence_literal(value)
            elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == TABULAR_ATTR:
                self.tablename_func = stmt
        # Table-args columns/constraints after body columns, written order.
        if table_args_node is not None:
            column_calls.extend(_table_args_column_calls(table_args_node))
        self.column_facts = _facts_from_column_calls(column_calls)
        # Explicit constraint columns are the authoritative ordered key.
        if table_args_node is not None:
            for element in _table_args_elements(table_args_node):
                constraint = _pk_constraint_columns(element)
                if constraint is not None:
                    self.column_facts.primary_key_columns = constraint
                    self.column_facts.has_pk_constraint = True

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

    def is_table_candidate(self, idx: "FileIndex", model_names: frozenset[str] = frozenset()) -> bool:
        """Whether this class claims a SQL table under the phase-2 predicate.

        A class is a candidate iff it has explicit table facts OR one of
        its bases statically resolves to a declarative base (see the
        module docstring for the full conservative-resolution contract).
        The old predicate — ``has_facts or bool(self.bases)`` — made every
        based class (Pydantic models, Enums, ABCs, Exceptions, plain
        project bases) a table candidate and emitted ~1,100 false-positive
        blocking entries in a real dogfood; a base list alone is evidence
        of NOTHING.

        Args:
            idx: The owning file index (import map + declarative aliases).
            model_names: Simple names of already-detected model classes
                across ALL scanned files (inheritance closure, computed to
                a fixpoint by `scan` before emission).

        Returns:
            bool: True only for genuine SQLAlchemy table candidates.
        """
        has_facts = (
            self.tablename_literal is not None
            or self.tablename_expr is not None
            or self.tablename_func is not None
            or "table" in self.keywords
        )
        if has_facts:
            return True
        return any(idx.base_is_declarative(base, model_names) for base in self.bases)


def _literal_record(node: ast.expr) -> dict[str, str | int | float | bool] | None:
    """Reads a dict literal of string keys and scalar values, else None.

    Args:
        node: The AST expression (e.g. the value of ``__gateforge_archive_state__``).

    Returns:
        dict | None: {field: literal scalar} preserving written order, or
            None when any key/value is non-literal (the caller reports it
            unresolved — the archived state is never guessed).
    """
    if not isinstance(node, ast.Dict):
        return None
    record: dict[str, str | int | float | bool] = {}
    for k, v in zip(node.keys, node.values):
        if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
            return None
        if not (isinstance(v, ast.Constant) and isinstance(v.value, (str, int, float, bool))):
            return None
        record[k.value] = v.value
    return record


def _string_sequence_literal(node: ast.expr) -> list[str] | None:
    """Reads a list/tuple literal of distinct non-empty string literals.

    Args:
        node: The AST expression (e.g. the value of
            ``__gateforge_updateable_fields__``).

    Returns:
        list[str] | None: the strings in written order, or None when the
            node is not a list/tuple of string literals (the classifier
            then simply sees no attribute — never a guessed one).
    """
    if not isinstance(node, (ast.List, ast.Tuple)):
        return None
    values: list[str] = []
    for elt in node.elts:
        if not (isinstance(elt, ast.Constant) and isinstance(elt.value, str) and elt.value):
            return None
        values.append(elt.value)
    return values or None


def _table_args_elements(node: ast.expr | None) -> list[ast.expr]:
    """The elements of a tuple ``__table_args__`` (or the node itself)."""
    if isinstance(node, ast.Tuple):
        return list(node.elts)
    if node is not None:
        return [node]
    return []


def _table_args_column_calls(node: ast.expr | None) -> list[tuple[ast.Call, str | None]]:
    """Column-constructor calls inside ``__table_args__``, written order."""
    calls: list[tuple[ast.Call, str | None]] = []
    for element in _table_args_elements(node):
        if isinstance(element, ast.Call) and _column_call_name(element) is not None:
            calls.append((element, None))
    return calls


class FileIndex:
    """One parsed file plus every detector fact gathered from it."""

    def __init__(self, relpath: str, tree: ast.Module):
        self.relpath = relpath
        self.classes: list[ClassRecord] = []
        self.table_calls: list[dict] = []  # {table_name, target, node}
        # Module-level bindings of the form ``X = declarative_base()`` /
        # ``X = <alias>.declarative_base()`` / ``X =
        # registry().generate_base()``, plus ``class X(DeclarativeBase)``
        # style declarations: names that act as declarative bases IN THIS
        # FILE (phase 2 resolution rule 2a).
        self.declarative_base_aliases: set[str] = set()
        # Names assigned from a ``registry()`` call; their
        # ``.generate_base()`` results register declarative aliases.
        self.registry_aliases: set[str] = set()
        # Local-name -> ImportRef map for base-name provenance (phase 2
        # denylist and import-alias resolution of declarative calls).
        self.imports: dict[str, ImportRef] = {}
        # Simple names defined in THIS file with a denylisted base (set
        # properly at the end of `_collect`; empty until then).
        self.locally_denied_base_names: set[str] = set()
        self._collect(tree)

    def _collect(self, tree: ast.Module) -> None:
        assigned_call_nodes: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self._record_import(node)
            if isinstance(node, ast.Assign):
                target = (
                    node.targets[0].id
                    if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                    else None
                )
                if isinstance(node.value, ast.Call):
                    fname = call_name(node.value.func)
                    if not self._call_provenance_denied(fname) and target:
                        # Import-alias aware: ``from sqlalchemy.orm import
                        # declarative_base as dbase`` makes ``dbase()``
                        # register too; a denylisted provenance (e.g.
                        # ``from pydantic import x as declarative_base``)
                        # registers NOTHING (fail closed vs false models).
                        effective = self._effective_call_name(fname)
                        if effective == "declarative_base":
                            self.declarative_base_aliases.add(target)
                        elif effective == "registry":
                            self.registry_aliases.add(target)
                        elif (
                            isinstance(node.value.func, ast.Attribute)
                            and node.value.func.attr == "generate_base"
                            and self._receiver_is_registry(node.value.func.value)
                        ):
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
        self._register_declarative_class_aliases()
        self._register_locally_denied_base_names()

    def _record_import(self, node: ast.Import | ast.ImportFrom) -> None:
        """Records one import statement's bindings into the import map."""
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                local = alias.asname or alias.name
                self.imports[local] = ImportRef(module=module, name=alias.name, level=node.level)
        else:
            for alias in node.names:
                local = alias.asname or alias.name.split(".")[0]
                self.imports[local] = ImportRef(module=alias.name, name=None, level=0)

    def _effective_call_name(self, fname: str | None) -> str | None:
        """A call's simple name with import aliases resolved.

        ``from sqlalchemy.orm import declarative_base as dbase`` binds
        ``dbase`` to imported name ``declarative_base``, so a ``dbase()``
        call is seen as the declarative factory it is.
        """
        if fname is None:
            return None
        ref = self.imports.get(fname)
        if ref is not None and ref.name:
            return ref.name
        return fname

    def _call_provenance_denied(self, fname: str | None) -> bool:
        """Whether a call's simple name is imported from a denylisted module."""
        if fname is None:
            return False
        ref = self.imports.get(fname)
        return ref is not None and module_denied(ref.module)

    def _receiver_is_registry(self, expr: ast.expr) -> bool:
        """Whether ``expr`` (the receiver of ``.generate_base()``) is a registry."""
        if isinstance(expr, ast.Call):
            fname = call_name(expr.func)
            return self._effective_call_name(fname) == "registry" and not self._call_provenance_denied(fname)
        if isinstance(expr, ast.Name):
            return expr.id in self.registry_aliases
        return False

    def _register_declarative_class_aliases(self) -> None:
        """Registers ``class X(DeclarativeBase)``-style names as base aliases.

        Applied iteratively to a fixpoint so an alias chain inside one
        file (``class Base(DeclarativeBase)``, then ``class NewBase(Base)``
        acting as a project-wide base) registers every member. Only the
        per-FILE alias registry is extended here; cross-file chains are
        the global model-name closure in `scan`.
        """
        changed = True
        while changed:
            changed = False
            for rec in self.classes:
                simple = rec.qname.rsplit(".", 1)[-1]
                if simple in self.declarative_base_aliases:
                    continue
                if any(
                    (b == "DeclarativeBase" and not self._import_denied(b))
                    or b in self.declarative_base_aliases
                    for b in rec.bases
                ):
                    self.declarative_base_aliases.add(simple)
                    changed = True

    def _register_locally_denied_base_names(self) -> None:
        """Records simple names DEFINED IN THIS FILE with a denylisted base.

        ``class WebhookEvent(BaseModel)`` (Pydantic schema file) sharing a
        simple name with a genuine ``class WebhookEvent(Base)`` (models
        file) is the motivating collision: the global model-name closure
        matches by simple name only, so without this registry the local
        non-model — and every local subclass of it — silently inherits
        candidacy from the remote namesake. A denylisted base is positive
        non-model evidence; the closure must never override it.
        """
        self.locally_denied_base_names: set[str] = set()
        for rec in self.classes:
            if any(self._import_denied(b) for b in rec.bases):
                self.locally_denied_base_names.add(rec.qname.rsplit(".", 1)[-1])

    def _import_denied(self, name: str) -> bool:
        """Whether a base simple name is bound from a denylisted module."""
        ref = self.imports.get(name)
        return ref is not None and module_denied(ref.module)

    def base_is_declarative(self, name: str, model_names: frozenset[str]) -> bool:
        """Whether one base simple name makes its class a declarative model.

        The phase-2 resolution rules, in order: a denylisted provenance
        vetoes EVERYTHING (even the exact name ``Base`` — this kills
        ``from pydantic import BaseModel as Base``); then the exact
        conventional names (``Base``, ``DeclarativeBase`` — exact only,
        so ``BaseModel``/``BaseSettings``/``BaseException`` never match),
        a locally registered declarative alias, or membership in the
        global model-name closure (inheritance across files).

        Args:
            name: The base's simple name.
            model_names: Simple names of detected model classes so far.

        Returns:
            bool: True only when the base is a declarative root.
        """
        if self._import_denied(name):
            return False
        if name in self.locally_denied_base_names:
            # A class with this simple name is DEFINED IN THIS FILE with a
            # denylisted base (e.g. ``class WebhookEvent(BaseModel)`` next
            # to a genuine ``class WebhookEvent(Base)`` in a models module).
            # Local definition evidence beats the cross-file closure: the
            # closure matches by simple name only, so without this veto the
            # local non-model and every local subclass of it silently
            # inherit candidacy from the remote namesake (a real dogfood
            # produced exactly this collision).
            return False
        if name == "Base":
            return True
        if name == "DeclarativeBase":
            return True
        if name in self.declarative_base_aliases:
            return True
        return name in model_names

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

    def class_by_qname(self, qname: str) -> ClassRecord | None:
        """The class record with an exact dotted qname, if any."""
        for rec in self.classes:
            if rec.qname == qname:
                return rec
        return None

    def class_by_simple_name(self, name: str) -> ClassRecord | None:
        """The first class record with this simple name, if any.

        Duplicate simple names inside one file (GF-01 territory) are a
        real ambiguity: the first record wins deterministically, and any
        collision finding built on the wrong record stays conservative
        (unresolvable roots are never treated as distinct).
        """
        for rec in self.classes:
            if rec.qname.rsplit(".", 1)[-1] == name:
                return rec
        return None


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
            **_attribute_facts(rec.column_facts, rec),
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


# -- Classification signals (plan phase 3, ADR 0003 D1) --------------------

def _signal(
    dimension: str,
    assertion: "str | bool | list[str] | dict[str, str | int | float | bool]",
    basis: str,
    source: str,
    location: dict,
    target_name: str,
    target_symbol: "str | None" = None,
) -> dict:
    """One canonical classification signal targeting a resource.

    Args:
        dimension: The classification dimension.
        assertion: The dimension-typed assertion payload.
        basis: The evidence basis (never a confidence score).
        source: The issuing source (`PLUGIN_ID` or `gateforge.declaration:<key>`).
        location: Where the evidence lives.
        target_name: The bare resource name the signal speaks about.
        target_symbol: The declaring class qname, when the evidence is
            class-derived. Symbol-scoped targets bind ONLY to their own
            class — a same-named table in another module/plane (the
            two-Base consumer shape) must never inherit another tree's
            declaration.

    Returns:
        dict: A @gate-forge/core `ClassificationSignal` document.
    """
    target: dict = {"resourceName": target_name}
    if target_symbol is not None:
        target["symbol"] = target_symbol
    return {
        "schemaVersion": 1,
        "target": target,
        "dimension": dimension,
        "assertion": assertion,
        "basis": basis,
        "source": source,
        "location": location,
        "detector": {"id": PLUGIN_ID, "version": VERSION},
    }


def _identity_signal(rec_or_facts: "ClassRecord | ColumnFacts", relpath: str, target_name: str, node: ast.AST) -> dict | None:
    """The ordered primary-key signal for a table, or None when unprovable.

    Args:
        rec_or_facts: The class record (or bare column facts of a Table call).
        relpath: Repo-root-relative source path.
        target_name: The bare table name.
        node: The declaration node the evidence lives at.

    Returns:
        dict | None: The `identity` signal with ordered columns (composite
            order preserved), or None when no literal key was derivable.
    """
    facts = rec_or_facts.column_facts if isinstance(rec_or_facts, ClassRecord) else rec_or_facts
    if not facts.has_pk_evidence:
        return None
    return _signal(
        "identity",
        list(facts.primary_key_columns),
        "code-positive",
        PLUGIN_ID,
        loc(relpath, node),
        target_name,
        rec_or_facts.qname if isinstance(rec_or_facts, ClassRecord) else None,
    )


def _declaration_signals(rec: ClassRecord, relpath: str, target_name: str) -> list[dict]:
    """Declaration signals from machine-readable class declarations.

    Args:
        rec: The class record.
        relpath: Repo-root-relative source path.
        target_name: The bare table name.

    Returns:
        list[dict]: `delete-semantics`, `archive-state`, and read-only
            `lifecycle.*` declaration signals. Declarations are ASSERTIONS
            for the core classifier — never suppressions on their own.
    """
    signals: list[dict] = []
    if rec.delete_semantics_literal is not None:
        signals.append(
            _signal(
                "delete-semantics",
                rec.delete_semantics_literal,
                "declaration",
                "gateforge.declaration:delete-semantics",
                loc(relpath, rec.node),
                target_name,
                rec.qname,
            )
        )
    if rec.archive_state_literal is not None:
        signals.append(
            _signal(
                "archive-state",
                rec.archive_state_literal,
                "declaration",
                "gateforge.declaration:archive-state",
                loc(relpath, rec.node),
                target_name,
                rec.qname,
            )
        )
    if rec.read_only:
        for operation in ("create", "update", "delete"):
            signals.append(
                _signal(
                    f"lifecycle.{operation}",
                    False,
                    "declaration",
                    "gateforge.declaration:read-only",
                    loc(relpath, rec.node),
                    target_name,
                    rec.qname,
                )
            )
    return signals


def _attribute_facts(facts: ColumnFacts, rec: ClassRecord | None) -> dict:
    """Non-authoritative attribute facts for cross-artifact linkage.

    Args:
        facts: The extracted column facts.
        rec: The class record (None for Table() calls).

    Returns:
        dict: Attribute entries (only when non-empty): ordered
            `primaryKeyColumns`, `foreignKeyReferences` (sorted by
            column), `softDeleteCandidateFields`, and `readOnly`.
    """
    entries: dict = {}
    if facts.has_pk_evidence:
        entries["primaryKeyColumns"] = list(facts.primary_key_columns)
    if facts.foreign_keys:
        entries["foreignKeyReferences"] = [
            {"column": column, "references": facts.foreign_keys[column]}
            for column in sorted(facts.foreign_keys)
        ]
    if facts.soft_delete_candidates:
        entries["softDeleteCandidateFields"] = sorted(set(facts.soft_delete_candidates))
    if rec is not None and rec.read_only:
        entries["readOnly"] = True
    if rec is not None and rec.updateable_fields_literal:
        entries["updateableFields"] = list(rec.updateable_fields_literal)
    return entries


def _signal_unresolved_entries(rec: ClassRecord, relpath: str, has_identity: bool) -> list[dict]:
    """Typed unresolved entries for unprovable identity/archive facts.

    Args:
        rec: The class record.
        relpath: Repo-root-relative source path.
        has_identity: Whether an `identity` signal was emitted (skips the
            primary-key entry — the key is proven).

    Returns:
        list[dict]: ``PRIMARY_KEY_UNRESOLVED`` when the table's key is
            computed or not visible in the class (inherited keys count as
            not visible), and ``ARCHIVE_STATE_UNRESOLVED`` when the
            archive declaration's value is non-literal. Never guesses.
    """
    entries: list[dict] = []
    facts = rec.column_facts
    if not has_identity and not facts.has_pk_evidence:
        if facts.has_computed_pk_arg:
            detail = (
                "primary_key_unresolved: a primary_key argument is computed "
                "(not the literal True); the ordered key is never guessed"
            )
        elif facts.has_pk_constraint:
            detail = (
                "primary_key_unresolved: PrimaryKeyConstraint columns are "
                "not all string literals; the ordered key is never guessed"
            )
        else:
            detail = (
                "primary_key_unresolved: no literal primary-key column is "
                "declared on this class (an inherited mixin/base key is not "
                "visible to the AST scan); the key is never defaulted to 'id'"
            )
        entries.append(
            {
                "code": "PRIMARY_KEY_UNRESOLVED",
                "detail": detail,
                "location": loc(relpath, rec.node),
            }
        )
    if rec.archive_state_expr is not None:
        entries.append(
            {
                "code": "ARCHIVE_STATE_UNRESOLVED",
                "detail": (
                    "archive_state_unresolved: "
                    f"{ARCHIVE_STATE_ATTR} is assigned from "
                    f"{expr_label(rec.archive_state_expr)}; the owner-owned "
                    "archived field values are never guessed"
                ),
                "location": loc(relpath, rec.node),
            }
        )
    return entries


def _table_call_facts(call: dict) -> ColumnFacts:
    """Column facts of a direct ``Table(...)`` call (positional columns).

    Args:
        call: The recorded Table-call facts.

    Returns:
        ColumnFacts: Facts from the call's column arguments, written order.
    """
    node = call["node"]
    calls: list[tuple[ast.Call, str | None]] = []
    for arg in node.args[2:]:
        if isinstance(arg, ast.Call) and _column_call_name(arg) is not None:
            calls.append((arg, None))
    return _facts_from_column_calls(calls)


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


def _module_to_relpath(indexes: dict[str, "FileIndex"], module: str) -> str | None:
    """Maps a dotted module to the scanned file that defines it.

    Args:
        indexes: Parsed-file indexes of one discovery request, keyed by
            repo-root-relative path.
        module: The dotted module of an import (absolute portion).

    Returns:
        str | None: The scanned relpath whose dotted module path equals
            ``module`` or ends with ``.<module>`` (package-rooted
            layouts: ``backend`` on disk, ``app.backend`` in imports),
            when exactly one file matches; ``None`` when nothing or more
            than one matches (ambiguous provenance is never guessed).
    """
    matches: list[str] = []
    for relpath in indexes:
        parts = relpath.replace("\\", "/").split("/")
        if parts and parts[-1].endswith(".py"):
            parts[-1] = parts[-1][: -len(".py")]
        if parts and parts[-1] == "__init__":
            parts = parts[:-1]
        dotted = ".".join(parts)
        if dotted == module or dotted.endswith("." + module):
            matches.append(relpath)
    return matches[0] if len(matches) == 1 else None


def _resolve_base_root(
    indexes: dict[str, "FileIndex"],
    relpath: str,
    name: str,
    visited: set[tuple[str, str]],
) -> str | None:
    """Resolves one base simple name to its declarative ROOT identity.

    The identity of a SQLAlchemy ``MetaData`` is the declarative root a
    model descends from, so two same-named tables collide only when
    their roots coincide. Resolution follows the evidence a flat scan
    can actually see, in order:

    1. a locally registered declarative alias in the referencing file
       (``X = declarative_base()``, ``class X(DeclarativeBase)``
       chains) — identity is the alias itself, file-qualified;
    2. a locally defined class — its own bases are chased (first base
       that resolves wins, so mixins in front of the root are skipped);
    3. the literal ``DeclarativeBase`` — every direct subclass creates
       its OWN registry, so the identity is the referencing CLASS
       (passed via ``visited`` seed), not a shared global name;
    4. an import — the imported name is resolved inside the scanned
       file that defines its module (exact or package-rooted suffix
       match, unique only), recursively; when no scanned file matches,
       the identity degrades to the module-qualified definition site,
       which still distinguishes two different source modules.

    Args:
        indexes: Parsed-file indexes of one discovery request.
        relpath: Repo-root-relative path of the file referencing ``name``.
        name: The base simple name to resolve.
        visited: (relpath, name) pairs already being resolved (cycle guard).

    Returns:
        str | None: The root identity id, or ``None`` when unprovable
            (the caller must then treat the declaration as NOT provably
            distinct — fail closed).
    """
    key = (relpath, name)
    if key in visited:
        return None
    visited.add(key)
    idx = indexes.get(relpath)
    if idx is None:
        return None
    if name in idx.declarative_base_aliases:
        return f"alias:{relpath}#{name}"
    rec = idx.class_by_simple_name(name)
    if rec is not None:
        # Chase the class's own bases in order; a leading mixin with no
        # declarative root of its own resolves to None here and the loop
        # simply continues to the next base (``class Account(Mixin, Base)``
        # must root at Base, not at the mixin). When NOTHING resolves the
        # name is unprovable — None keeps every pair involving it flagged.
        for base in rec.bases:
            resolved = _resolve_base_root(indexes, relpath, base, visited)
            if resolved is not None:
                return resolved
        return None
    if name == "DeclarativeBase":
        return None  # handled by the caller via its own class identity
    ref = idx.imports.get(name)
    if ref is None or not ref.name or module_denied(ref.module):
        return None
    module = ref.module
    if ref.level > 0:
        # Relative imports resolve against the referencing file's package:
        # ``pkg/sub/mod.py`` is package ``pkg.sub``; level 1 is that
        # package itself, each further level pops one segment.
        package = relpath.replace("\\", "/").split("/")[:-1]
        if ref.level > 1:
            drop = ref.level - 1
            if len(package) < drop:
                return None
            package = package[: len(package) - drop]
        module = ".".join([*package, ref.module]) if ref.module else ".".join(package)
        if not module:
            return None
    mapped = _module_to_relpath(indexes, module)
    if mapped is not None:
        return _resolve_base_root(indexes, mapped, ref.name or name, visited)
    return f"module:{module}.{ref.name}"


def _table_base_identities(
    indexes: dict[str, "FileIndex"], resource: dict
) -> set[str] | None:
    """The set of declarative root ids one table resource sits on.

    Args:
        indexes: Parsed-file indexes of one discovery request.
        resource: A ``sqlalchemy.table`` business resource.

    Returns:
        set[str] | None: The resolved root ids, or ``None`` when any
            direct base is unprovable or the resource carries no class
            evidence (``Table("name", ...)`` calls) — the caller must
            treat ``None`` as NOT provably distinct from anything.
    """
    qname = resource["attributes"].get("classQname")
    if not qname:
        return None
    idx = indexes.get(resource["source"])
    if idx is None:
        return None
    rec = idx.class_by_qname(qname)
    if rec is None or not rec.bases:
        return None
    # Identity-bearing bases only: a base that resolves to None is a
    # mixin or an unproven name — it contributes no MetaData identity of
    # its own, so it is skipped as long as at least one base resolves.
    # If NOTHING resolves, the declaration is unprovable (None → never
    # treated as distinct — fail closed).
    sites: set[str] = set()
    for base in rec.bases:
        if base == "DeclarativeBase" and base not in idx.declarative_base_aliases:
            # The class subclasses DeclarativeBase directly: it creates
            # its own registry, so ITS identity is the root.
            sites.add(f"root:{resource['source']}#{qname}")
            continue
        resolved = _resolve_base_root(indexes, resource["source"], base, set())
        if resolved is not None:
            sites.add(resolved)
    return sites or None


def _provably_distinct(
    indexes: dict[str, "FileIndex"], group: list[dict]
) -> bool:
    """Whether every same-named declaration pair sits on a different root.

    Args:
        indexes: Parsed-file indexes of one discovery request.
        group: The same-``__tablename__`` table resources (≥2).

    Returns:
        bool: True only when EVERY pair carries fully-resolved,
            disjoint root-id sets — separate ``MetaData`` at runtime,
            so no collision is possible. Any unresolved or intersecting
            pair makes the group a finding candidate (fail closed).
    """
    identities = [_table_base_identities(indexes, resource) for resource in group]
    for first in range(len(identities)):
        for second in range(first + 1, len(identities)):
            left = identities[first]
            right = identities[second]
            if left is None or right is None or not left.isdisjoint(right):
                return False
    return True


def _duplicate_findings(resources: list[dict], indexes: dict[str, "FileIndex"]) -> list[dict]:
    """Duplicate table names (GF-20), BASE-QUALIFIED since detector 0.2.0.

    Same ``__tablename__`` in 2 files or twice in 1 is a finding unless
    every pair of declarations provably sits on a different declarative
    Base root (separate ``MetaData`` at runtime — the motivating real
    dogfood collisions were a test-file fixture Base and an intentional
    tenant/master model split, both correct code). Same name on
    different PLANES is never the detector's call either: plane
    qualification owns identity collapse (the graph's
    ``detectDuplicateIds``).

    Args:
        resources: The business table resources of one discovery request.
        indexes: Parsed-file indexes of one discovery request.

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
        if _provably_distinct(indexes, group):
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


def _class_name_findings(
    indexes: dict[str, FileIndex], model_names: frozenset[str] = frozenset()
) -> list[dict]:
    """Repeated class names in one file (GF-01): non-collapse proof.

    Only classes that EMIT SOMETHING (table candidates, pure bases) take
    part: a repeated simple name can only create linkage ambiguity when
    the repeated class becomes a resource the classifier can address by
    name. Non-emitting classes (Pydantic's nested ``Config`` idiom, for
    example) have no resource identity to confuse, so repeating them is
    not a detector fact — flagging them blocked a real dogfood on noise.

    Args:
        indexes: Parsed-file indexes of one discovery request.
        model_names: The pass-0 inheritance closure, so candidate-hood is
            judged under the SAME resolution the emission passes use.

    Returns:
        list[dict]: One finding per repeated simple class name per file.
    """
    findings: list[dict] = []
    for relpath in sorted(indexes):
        by_simple: dict[str, list[ClassRecord]] = {}
        for rec in indexes[relpath].classes:
            if not (
                rec.is_table_candidate(indexes[relpath], model_names)
                or rec.is_pure_base(indexes[relpath])
            ):
                continue
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
        dict: {"resources": [...], "unresolved": [...], "findings": [...],
            "classificationSignals": [...]} with every array
            deterministically sorted.

    Raises:
        OSError: A scanned file is missing/unreadable — surfaced as a
            plugin error frame by the serve loop (fail closed).
    """
    base = root if root is not None else Path.cwd()
    relpaths = [_normalize_path(p) for p in paths]

    indexes: dict[str, FileIndex] = {}
    findings: list[dict] = []
    scanned: list[str] = []
    for relpath in relpaths:
        if not relpath.endswith(".py"):
            continue
        index, finding = _scan_file(relpath, base)
        if finding is not None:
            findings.append(finding)
            continue
        scanned.append(relpath)
        indexes[relpath] = index
    resources: list[dict] = []
    unresolved: list[dict] = []
    signals: list[dict] = []

    # Pass 0: the model-name inheritance closure (phase 2). Starting from
    # every class with table facts or a declarative root, a base whose
    # SIMPLE name equals a detected model's simple name makes its class a
    # model too — iterated to a fixpoint over ALL scanned files, because
    # a flat file scan sees ``class SalariedEmployee(Employee)`` and
    # ``class Employee(Base)`` in arbitrary order (or in different files)
    # and multi-level chains must still resolve. Only the closure is
    # global: a name enters it exclusively through the conservative
    # per-file predicate, never through bare base lists.
    model_names: set[str] = set()
    changed = True
    while changed:
        changed = False
        for idx in indexes.values():
            for rec in idx.classes:
                simple = rec.qname.rsplit(".", 1)[-1]
                if simple in model_names:
                    continue
                if rec.is_table_candidate(idx, model_names):
                    model_names.add(simple)
                    changed = True

    # Pass 1: class symbols + business tables + typed unresolved + signals.
    for relpath in sorted(indexes):
        idx = indexes[relpath]
        for rec in idx.classes:
            if rec.is_table_candidate(idx, model_names) or rec.is_pure_base(idx):
                last_segment_unresolved = (
                    rec.tablename_literal is None and not rec.is_pure_base(idx)
                )
                resources.append(_symbol_resource(relpath, rec, last_segment_unresolved))
            if rec.is_pure_base(idx):
                continue  # bases never materialize; the symbol table owns them
            if rec.tablename_literal is not None:
                resources.append(_table_resource(relpath, rec, "literal"))
                table_name = rec.tablename_literal
                identity = _identity_signal(rec, relpath, table_name, rec.node)
                if identity is not None:
                    signals.append(identity)
                signals.extend(_declaration_signals(rec, relpath, table_name))
                unresolved.extend(_signal_unresolved_entries(rec, relpath, identity is not None))
            elif rec.is_table_candidate(idx, model_names):
                unresolved.append(_unresolved_entry(relpath, rec))

    # Pass 2: direct Table("name", ...) declarations.
    for relpath in sorted(indexes):
        for call in indexes[relpath].table_calls:
            resources.append(_call_table_resource(relpath, call))
            facts = _table_call_facts(call)
            identity = _identity_signal(facts, relpath, call["table_name"], call["node"])
            if identity is not None:
                signals.append(identity)

    resources.sort(key=lambda r: r["id"])
    unresolved.sort(
        key=lambda u: (
            u["location"]["file"], u["location"]["line"],
            u["location"]["col"], u["code"], u["detail"],
        )
    )
    findings.extend(_duplicate_findings(resources, indexes))
    findings.extend(_class_name_findings(indexes, frozenset(model_names)))
    findings.sort(
        key=lambda f: (
            f["code"], f["detail"],
            f["locations"][0]["file"] if f["locations"] else "",
            f["locations"][0]["line"] if f["locations"] else 0,
        )
    )
    # Canonical wire order: by GF-canonical-JSON text — deterministic and
    # identical to what the core classifier's signalId sorting expects.
    signals.sort(key=lambda s: json.dumps(s, sort_keys=True, separators=(",", ":"), ensure_ascii=False))

    return {
        "resources": resources,
        "unresolved": unresolved,
        "findings": findings,
        "classificationSignals": signals,
        # Coverage evidence (ADR 0003 D4): files parsed successfully.
        "scannedPaths": sorted(scanned),
    }