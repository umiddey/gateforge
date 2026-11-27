"""Code-derived internal reachability for SQLAlchemy tables (P3 i).

A table is internal for an entry-point category when an entry point of that
category reaches a writer of the table. Every list below is closed: a shape
that is not named gives no edge and no writer, and so no signal.

The ``unreferenced`` category is no entry-point category. It is derived from a
whole-scan reference check (``_References``): a table that no serving module
names can be written by no request.

The walk works on ``ast`` only. Nothing here imports or runs the scanned code.
"""

from __future__ import annotations

import ast
import re
from collections import Counter

from . import PLUGIN_ID
from .scan import _module_to_relpath, _signal, loc

SA_MODULES = frozenset({"sqlalchemy", "sqlalchemy.orm"})
# A `__main__` block that reaches one of these starts a server: no entry point.
SERVER_NAMES = frozenset({"run", "serve", "serve_forever"})
WRITE_CALLS = frozenset({"insert", "update", "delete"})
SESSION_ADD_CALLS = frozenset({"add", "add_all"})
SQL_IDENT = r'(?:"(?:[^"]|"")+"|\w+)'
LITERAL_WRITE = re.compile(
    rf"^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"
    rf"(?:ONLY\s+(?!(?:SET|WHERE|VALUES|SELECT|USING)\b))?"
    rf"(?:{SQL_IDENT}\s*\.\s*)?({SQL_IDENT})",
    re.IGNORECASE,
)
SCOPE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
# Decorators that hand a method to no other code. Any other decorator inside a
# table class counts as a reference to that class.
INERT_DECORATORS = frozenset({
    "property", "classmethod", "staticmethod", "hybrid_property", "hybrid_method",
    "validates", "declared_attr", "reconstructor",
})
INERT_ACCESSORS = frozenset({"setter", "expression", "deleter"})
# Attributes that walk the mapper or metadata registry: a table reached that way is named nowhere.
REGISTRY_ATTRS = frozenset({"sorted_tables", "mappers", "_class_registry", "__subclasses__"})
WORD = re.compile(r"[A-Za-z0-9_]+")
DOTTED_HEAD = re.compile(r"[A-Za-z0-9_.]+")
FORMAT_FIELD = re.compile(r"\{[^{}]*\}|%(?:\(\w*\))?[A-Za-z]")
# An inserting statement whose target holds an interpolation (``\0`` in a
# ``_template`` text), anchored like LITERAL_WRITE. A computed schema before a
# literal table is no match: the literal names the table.
COMPUTED_WRITE = re.compile(
    r'^\s*(?:INSERT\s+INTO|MERGE\s+INTO|\\?COPY)\s+'
    r'(?:[\w"\0]+\s*\.\s*)*[\w"]*\0[\w"\0]*(?![\w"\0]|\s*\.)',
    re.IGNORECASE,
)


def reachability_signals(indexes, trees, tables, categories, others, root):
    """Derives one ``internality`` signal per (table, category) that holds.

    Args:
        indexes: ``{relpath: FileIndex}`` for every scanned, non-test file.
        trees: ``{relpath: ast.Module}``, the same files as ``indexes``.
        tables: ``[(relpath, class_qname_or_None, table_name)]`` for every
            table resource: a declarative class (qname set) or a ``Table()``
            call (qname None).
        categories: The categories to derive, a subset of ``migration``,
            ``maintenance-command``, ``worker`` and ``unreferenced``. The
            first three give a signal at each entry point that reaches a
            writer of the table. ``unreferenced`` gives a signal at the
            definition of each table that no serving module names; granting
            it trusts revision modules and standalone scripts as operator
            code (see ``_References``).
        others: Relpaths of the non-test inputs that are not in ``indexes``.
            Read as bytes, and only for ``unreferenced``.
        root: The scan root ``others`` resolve under.

    Returns:
        list[dict]: ``ClassificationSignal`` documents (unsorted).
    """
    return _Walker(indexes, trees, tables).signals(categories, others, root)


def _own_nodes(stmts):
    """Yields the nodes of one function or block scope, skipping nested scopes.

    A nested function, class or lambda is yielded as one node (so its name
    still counts as a binding) but its body is not walked.
    """
    stack = list(stmts)
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, SCOPE_NODES):
            continue
        stack.extend(ast.iter_child_nodes(node))


def _final_name(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _str_const(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _listed(table):
    """A single resolved table as a one-item list, or an empty list."""
    return [table] if table is not None else []


def _is_main_guard(stmt):
    """True for a module-level ``if __name__ == "__main__":``."""
    if not isinstance(stmt, ast.If):
        return False
    test = stmt.test
    if not (
        isinstance(test, ast.Compare)
        and len(test.ops) == 1
        and isinstance(test.ops[0], ast.Eq)
        and len(test.comparators) == 1
    ):
        return False
    sides = [test.left, test.comparators[0]]
    names = [s for s in sides if isinstance(s, ast.Name) and s.id == "__name__"]
    consts = [s for s in sides if isinstance(s, ast.Constant) and s.value == "__main__"]
    return len(names) == 1 and len(consts) == 1


def _has_revision(tree):
    """True when the module binds ``revision`` to a string literal (alembic)."""
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign):
            targets = stmt.targets
        elif isinstance(stmt, ast.AnnAssign):
            targets = [stmt.target]
        else:
            continue
        bound = any(isinstance(t, ast.Name) and t.id == "revision" for t in targets)
        if bound and _str_const(stmt.value) is not None:
            return True
    return False


def _is_celery_class_call(node, imports):
    """True for a call to ``celery.Celery``, however celery was imported."""
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if isinstance(func, ast.Name):
        ref = imports.get(func.id)
        return ref is not None and ref.level == 0 and ref.module == "celery" and ref.name == "Celery"
    if isinstance(func, ast.Attribute) and func.attr == "Celery" and isinstance(func.value, ast.Name):
        ref = imports.get(func.value.id)
        return ref is not None and ref.level == 0 and ref.module == "celery" and ref.name is None
    return False


def _celery_bindings(tree, imports):
    """Module-level names bound by ``<name> = Celery(...)``, Celery being celery's."""
    names = set()
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and _is_celery_class_call(stmt.value, imports):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
    return names


def _param_nodes(fn):
    if fn is None:
        return []
    args = fn.args
    nodes = list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)
    if args.vararg is not None:
        nodes.append(args.vararg)
    if args.kwarg is not None:
        nodes.append(args.kwarg)
    return nodes


def _bound_names(own):
    """Every name a scope binds, once per binding; parameters excluded."""
    for node in own:
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            yield node.id
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            yield node.name
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                yield alias.asname or alias.name.split(".")[0]
        elif isinstance(node, ast.ExceptHandler) and node.name is not None:
            yield node.name


def _bound_count(own, name):
    """How many times a scope binds ``name``, parameters excluded."""
    return sum(1 for bound in _bound_names(own) if bound == name)


def _binding_source(own, name):
    """The value expression of the one plain binding of ``name``, if any."""
    for node in own:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in node.targets
        ):
            return node.value
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name:
            return node.value
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if isinstance(item.optional_vars, ast.Name) and item.optional_vars.id == name:
                    return item.context_expr
    return None


def _is_cursor(own, fn, name):
    """True when ``name`` is bound exactly once in the scope, to ``X.cursor()``, and is no parameter."""
    if _bound_count(own, name) != 1 or any(p.arg == name for p in _param_nodes(fn)):
        return False
    source = _binding_source(own, name)
    return isinstance(source, ast.Call) and isinstance(source.func, ast.Attribute) and source.func.attr == "cursor"


def _table_key(table):
    return (table[0], table[1] or "", table[2])


def _table_signal(table, category, location):
    relpath, symbol, name = table
    signal = _signal("internality", category, "code-positive", PLUGIN_ID, location, name, symbol)
    if symbol is not None:
        # A declarative class target carries its symbol only: the bare table
        # name would bind the signal to every same-named table in the scan.
        del signal["target"]["resourceName"]
    return signal


def _inert_decorator(dec):
    target = dec.func if isinstance(dec, ast.Call) else dec
    if isinstance(target, ast.Name):
        return target.id in INERT_DECORATORS
    return isinstance(target, ast.Attribute) and target.attr in INERT_ACCESSORS


def _binds_all(stmt):
    """True for a statement that binds ``__all__``."""
    if isinstance(stmt, ast.Assign):
        targets = stmt.targets
    elif isinstance(stmt, (ast.AnnAssign, ast.AugAssign)):
        targets = [stmt.target]
    else:
        return False
    return any(isinstance(t, ast.Name) and t.id == "__all__" for t in targets)


def _template(node):
    """The text of a string expression, with ``\\0`` for each part that is computed.

    F-strings and ``+`` chains are flattened left to right. A ``{...}`` or
    ``%s`` field in a literal part is computed too: ``.format`` or ``%`` fills
    it later, wherever that happens.
    """
    parts, stack = [], [node]
    while stack:
        cur = stack.pop()
        text = _str_const(cur)
        if text is not None:
            parts.append(FORMAT_FIELD.sub("\0", text))
        elif isinstance(cur, ast.JoinedStr):
            stack.extend(reversed(cur.values))
        elif isinstance(cur, ast.BinOp) and isinstance(cur.op, ast.Add):
            stack.extend((cur.right, cur.left))
        else:
            parts.append("\0")
    return "".join(parts)


def _dotted_suffixes(rel):
    """Every dotted name a scanned file can be imported under.

    The relation of ``_module_to_relpath``, without its one-match rule: for an
    exemption or a guard, an ambiguous name has to count for every file.
    """
    parts = rel[: -len(".py")].split("/")
    if parts[-1] == "__init__":
        parts.pop()
    return [".".join(parts[i:]) for i in range(len(parts))]


def _importable(node):
    """Dotted names a node may import: an import's modules, or the dotted head of a string.

    A string counts for its head when it ends there or goes on with ``:``
    (``"pkg.mod:app"``), and for every shorter prefix that ends before a ``.``.
    """
    if isinstance(node, ast.Import):
        texts = [alias.name for alias in node.names]
    elif isinstance(node, ast.ImportFrom):
        base = node.module or ""
        texts = [f"{base}.{alias.name}".lstrip(".") for alias in node.names]
        if node.level:
            # The package a relative import resolves under is unknown: every name it mentions counts.
            texts += [*base.split("."), *(alias.name for alias in node.names)]
    else:
        text = _str_const(node)
        texts = [] if text is None else [text]
    for text in texts:
        match = DOTTED_HEAD.match(text)
        if match is None:
            continue
        head = match.group()
        yield from (head[:i] for i, char in enumerate(head) if char == ".")
        if match.end() == len(text) or text[match.end()] == ":":
            yield head


def _note(index, token, where):
    """Adds ``where`` to the entry of ``token``; an index holds only the tokens asked for."""
    entry = index.get(token)
    if entry is not None:
        entry.add(where)


class _Walker:
    """Resolves entry points, call edges and writers over one scan's indexes."""

    def __init__(self, indexes, trees, tables):
        self.indexes = indexes
        self.trees = trees
        self.tables = list(tables)
        self.funcs = {
            rel: {
                stmt.name: stmt
                for stmt in tree.body
                if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
            for rel, tree in trees.items()
        }
        self.celery_apps = {rel: _celery_bindings(tree, self.indexes[rel].imports) for rel, tree in trees.items()}
        self.module_bound = {rel: Counter(_bound_names(_own_nodes(tree.body))) for rel, tree in trees.items()}

    # -- name resolution ------------------------------------------------

    def _rebound(self, rel, own, fn, name):
        """True when ``name`` is bound other than by its one module-level import."""
        if self.module_bound[rel][name] != 1:
            return True
        return _bound_count(own, name) > 0 or any(p.arg == name for p in _param_nodes(fn))

    def _sa_symbol(self, rel, node, own=(), fn=None):
        """The sqlalchemy (or sqlalchemy.orm) name a node refers to, else None.

        ``own`` and ``fn`` are the calling scope: a name rebound there, or
        passed as one of its parameters, is not the import.
        """
        imports = self.indexes[rel].imports
        if isinstance(node, ast.Name):
            ref = imports.get(node.id)
            if ref is not None and ref.level == 0 and ref.name is not None and ref.module in SA_MODULES:
                return None if self._rebound(rel, own, fn, node.id) else ref.name
            return None
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            ref = imports.get(node.value.id)
            if ref is None or ref.level != 0 or self._rebound(rel, own, fn, node.value.id):
                return None
            if ref.name is None and ref.module in SA_MODULES:
                return node.attr
            if ref.module == "sqlalchemy" and ref.name == "orm":
                return node.attr
        return None

    def _is_alembic_op(self, rel, node):
        if not isinstance(node, ast.Name):
            return False
        ref = self.indexes[rel].imports.get(node.id)
        return ref is not None and ref.level == 0 and ref.module == "alembic" and ref.name == "op"

    def _is_celery_import(self, rel, local, name):
        ref = self.indexes[rel].imports.get(local)
        return ref is not None and ref.level == 0 and ref.module == "celery" and ref.name == name

    def _celery_app(self, rel, local):
        if local in self.celery_apps[rel]:
            return True
        ref = self.indexes[rel].imports.get(local)
        if ref is None or ref.level != 0 or ref.name is None:
            return False
        target = _module_to_relpath(self.indexes, ref.module)
        return target is not None and ref.name in self.celery_apps[target]

    def _class_table(self, rel, name):
        """The one table class a model name resolves to, else None."""
        ref = self.indexes[rel].imports.get(name)
        if ref is None:
            target, want = rel, name
        elif ref.level == 0 and ref.name is not None:
            target = _module_to_relpath(self.indexes, ref.module)
            if target is None:
                return None
            want = ref.name
        else:
            return None
        hits = [
            t for t in self.tables
            if t[1] is not None and t[0] == target and t[1].rsplit(".", 1)[-1] == want
        ]
        return hits[0] if len(hits) == 1 else None

    def _literal_table(self, name):
        """The one table resource in the scan with this name, else None."""
        hits = [t for t in self.tables if t[2] == name]
        return hits[0] if len(hits) == 1 else None

    def _table_of(self, rel, own, fn, node):
        """The table an expression denotes.

        A model, ``M.__table__``, ``table("lit")``, or a name bound exactly
        once in the function to ``table("lit")``.
        """
        if isinstance(node, ast.Name):
            is_param = any(p.arg == node.id for p in _param_nodes(fn))
            source = _binding_source(own, node.id)
            if not is_param and source is None:
                return self._class_table(rel, node.id)
            # A parameter or a plain binding in this scope decides, not a model of that name.
            if fn is None or is_param or _bound_count(own, node.id) != 1 or not isinstance(source, ast.Call):
                return None
            return self._table_of(rel, own, fn, source)
        if isinstance(node, ast.Attribute) and node.attr == "__table__" and isinstance(node.value, ast.Name):
            return self._class_table(rel, node.value.id)
        if isinstance(node, ast.Call) and self._sa_symbol(rel, node.func, own, fn) == "table" and node.args:
            literal = _str_const(node.args[0])
            if literal is not None:
                return self._literal_table(literal)
        return None

    def _callee(self, rel, call):
        """The same-file or imported module-level function a call reaches."""
        func = call.func
        if isinstance(func, ast.Name):
            if func.id in self.funcs[rel]:
                return (rel, func.id)
            ref = self.indexes[rel].imports.get(func.id)
            if ref is not None and ref.level == 0 and ref.name is not None:
                target = _module_to_relpath(self.indexes, ref.module)
                if target is not None and ref.name in self.funcs[target]:
                    return (target, ref.name)
            return None
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            ref = self.indexes[rel].imports.get(func.value.id)
            if ref is not None and ref.level == 0 and ref.name is None:
                target = _module_to_relpath(self.indexes, ref.module)
                if target is not None and func.attr in self.funcs[target]:
                    return (target, func.attr)
        return None

    # -- writers --------------------------------------------------------

    def _is_session_ctor(self, rel, own, fn, node):
        if not isinstance(node, ast.Call):
            return False
        if self._sa_symbol(rel, node.func, own, fn) == "Session":
            return True
        return (
            isinstance(node.func, ast.Call)
            and self._sa_symbol(rel, node.func.func, own, fn) == "sessionmaker"
        )

    def _is_session_receiver(self, rel, own, fn, name):
        """True when ``name`` is bound exactly once in the scope, to a session."""
        params = [p for p in _param_nodes(fn) if p.arg == name]
        if len(params) + _bound_count(own, name) != 1:
            return False
        if params:
            annotation = params[0].annotation
            return annotation is not None and self._sa_symbol(rel, annotation, own, fn) == "Session"
        source = _binding_source(own, name)
        return source is not None and self._is_session_ctor(rel, own, fn, source)

    def _writes(self, rel, own, fn, call):
        """The tables one call writes, as a list of table tuples."""
        symbol = self._sa_symbol(rel, call.func, own, fn)
        if symbol is not None:
            return self._sa_writes(rel, own, fn, symbol, call)
        if isinstance(call.func, ast.Attribute):
            return self._method_writes(rel, own, fn, call)
        return []

    def _sa_writes(self, rel, own, fn, symbol, call):
        """Writes made by a sqlalchemy-imported call: ``insert(X)`` and ``text(S)``."""
        if symbol in WRITE_CALLS and call.args:
            return _listed(self._table_of(rel, own, fn, call.args[0]))
        if symbol == "text" and call.args:
            return self._literal_write(_str_const(call.args[0]))
        return []

    def _method_writes(self, rel, own, fn, call):
        """Writes made by a method call: ``X.__table__.insert()``, alembic ops, cursor literals and session adds."""
        func = call.func
        if func.attr in WRITE_CALLS and isinstance(func.value, ast.Attribute) and func.value.attr == "__table__":
            return _listed(self._table_of(rel, own, fn, func.value))
        if not call.args:
            return []
        if func.attr == "bulk_insert" and self._is_alembic_op(rel, func.value):
            return _listed(self._table_of(rel, own, fn, call.args[0]))
        if func.attr == "execute" and self._is_alembic_op(rel, func.value):
            return self._literal_write(_str_const(call.args[0]))
        if func.attr == "execute" and isinstance(func.value, ast.Name) and _is_cursor(own, fn, func.value.id):
            return self._literal_write(_str_const(call.args[0]))
        if (
            func.attr in SESSION_ADD_CALLS
            and isinstance(func.value, ast.Name)
            and self._is_session_receiver(rel, own, fn, func.value.id)
        ):
            return self._session_adds(rel, func.attr, call.args[0])
        return []

    def _session_adds(self, rel, attr, arg):
        """Tables of ``M(...)`` objects passed to ``add`` or to ``add_all([...])``."""
        items = arg.elts if attr == "add_all" and isinstance(arg, ast.List) else [arg]
        out = []
        for item in items:
            if isinstance(item, ast.Call) and isinstance(item.func, ast.Name):
                out.extend(_listed(self._class_table(rel, item.func.id)))
        return out

    def _literal_write(self, text):
        """The table a literal INSERT/UPDATE/DELETE statement names, if unambiguous."""
        if text is None:
            return []
        match = LITERAL_WRITE.match(text)
        if match is None:
            return []
        name = match.group(1)
        if name.startswith('"'):
            name = name[1:-1].replace('""', '"')
        return _listed(self._literal_table(name))

    # -- entry points and closure ---------------------------------------

    def _worker(self, rel, fdef):
        for dec in fdef.decorator_list:
            target = dec.func if isinstance(dec, ast.Call) else dec
            if isinstance(target, ast.Name) and self._is_celery_import(rel, target.id, "shared_task"):
                return True
            if (
                isinstance(target, ast.Attribute)
                and target.attr == "task"
                and isinstance(target.value, ast.Name)
                and self._celery_app(rel, target.value.id)
            ):
                return True
        return False

    def _is_functools_wraps(self, rel, dec):
        """True for a ``functools.wraps(...)`` or ``wraps(...)`` decorator call, functools being the import."""
        if not isinstance(dec, ast.Call):
            return False
        func = dec.func
        if isinstance(func, ast.Attribute) and func.attr == "wraps" and isinstance(func.value, ast.Name):
            ref = self.indexes[rel].imports.get(func.value.id)
            return ref is not None and ref.level == 0 and ref.module == "functools" and ref.name is None
        if isinstance(func, ast.Name):
            ref = self.indexes[rel].imports.get(func.id)
            return ref is not None and ref.level == 0 and ref.module == "functools" and ref.name == "wraps"
        return False

    def _decorator_bodies(self, rel, fdef, seen):
        """Wrapper bodies that module-level decorators of ``fdef`` return and ``seen`` has not yet met.

        ``@F(...)`` follows two nested returns (F returns D, D returns the wrapper); ``@F`` and
        ``@mod.F`` follow one (F returns the wrapper). Each returning body is a single
        ``return <name>`` of a def bound once in its own scope; each returned def may carry
        only ``functools.wraps`` decorators. Anything else yields no edge.
        """
        bodies = []
        for dec in fdef.decorator_list:
            factory = isinstance(dec, ast.Call)
            callee = self._callee(rel, dec if factory else ast.Call(func=dec, args=[], keywords=[]))
            if callee is None:
                continue
            frel, fname = callee
            outer, scope = None, self.funcs[frel][fname]
            for _ in range(2 if factory else 1):
                own = list(_own_nodes(scope.body))
                returns = [node for node in own if isinstance(node, ast.Return)]
                if len(returns) != 1 or not isinstance(returns[0].value, ast.Name):
                    break
                name = returns[0].value.id
                defs = [
                    node
                    for node in own
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name
                ]
                if _bound_count(own, name) != 1 or len(defs) != 1:
                    break
                nested = defs[0]
                if not all(self._is_functools_wraps(frel, d) for d in nested.decorator_list):
                    break
                outer, scope = scope, nested
            else:
                key = (frel, f"{outer.name}.<wrapper>@{scope.lineno}")
                if key not in seen:
                    seen.add(key)
                    bodies.append((frel, list(_own_nodes(scope.body)), scope))
        return bodies

    def _closure(self, rel, stmts, fn):
        """The entry body plus every module-level body it reaches, in BFS order.

        Each body is ``(relpath, own_nodes, function_node_or_None)``.
        """
        bodies = [(rel, list(_own_nodes(stmts)), fn)]
        seen = set()
        if fn is not None:
            seen.add((rel, fn.name))
            bodies.extend(self._decorator_bodies(rel, fn, seen))
        index = 0
        while index < len(bodies):
            cur_rel, own, _ = bodies[index]
            index += 1
            for node in own:
                if not isinstance(node, ast.Call):
                    continue
                callee = self._callee(cur_rel, node)
                if callee is None or callee in seen:
                    continue
                seen.add(callee)
                crel, cname = callee
                cfn = self.funcs[crel][cname]
                bodies.append((crel, list(_own_nodes(cfn.body)), cfn))
                bodies.extend(self._decorator_bodies(crel, cfn, seen))
        return bodies

    def _starts_server(self, bodies):
        return any(
            isinstance(node, ast.Call) and _final_name(node.func) in SERVER_NAMES
            for _, own, _ in bodies
            for node in own
        )

    def _entry_bodies(self, category, rel, tree, stmt):
        """The reached bodies when ``stmt`` is an entry point of ``category``, else None."""
        if category == "migration":
            if isinstance(stmt, ast.FunctionDef) and stmt.name == "upgrade" and _has_revision(tree):
                return self._closure(rel, stmt.body, stmt)
            return None
        if category == "maintenance-command":
            if not _is_main_guard(stmt):
                return None
            bodies = self._closure(rel, stmt.body, None)
            return None if self._starts_server(bodies) else bodies
        if category == "worker" and isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and self._worker(rel, stmt):
            return self._closure(rel, stmt.body, stmt)
        return None

    def _entries(self, category):
        """Entry points of one category, as ``(relpath, node, bodies)`` in (file, line, col) order."""
        found = []
        for rel in sorted(self.trees):
            tree = self.trees[rel]
            for stmt in tree.body:
                bodies = self._entry_bodies(category, rel, tree, stmt)
                if bodies is not None:
                    found.append((rel, stmt, bodies))
        found.sort(key=lambda e: (e[0], e[1].lineno, e[1].col_offset))
        return found

    def signals(self, categories, others, root):
        out = []
        for category in sorted(set(categories)):
            if category == "unreferenced":
                out.extend(_References(self, others, root).signals())
                continue
            emitted = set()
            for rel, node, bodies in self._entries(category):
                tables = set()
                for brel, own, fn in bodies:
                    for item in own:
                        if isinstance(item, ast.Call):
                            tables.update(self._writes(brel, own, fn, item))
                for table in sorted(tables - emitted, key=_table_key):
                    emitted.add(table)
                    out.append(_table_signal(table, category, loc(rel, node)))
        return out


class _References:
    """Finds the tables no serving module names (the ``unreferenced`` category).

    A statement that creates a row names its table where it is built: by class
    symbol, by ``Table`` variable or by table-name text. A table that no
    serving module names is therefore written by no request.

    A reference to a target is a ``Name`` or attribute equal to its symbol, an
    import of the symbol under another name, or a string that holds the symbol
    or the table name as a word (any letter case). A non-Python input counts
    for the table name as a word. Not references: the nodes of the target's
    own class, the ``Table(...)`` call's own name, docstrings and other bare
    strings, and the ``__all__`` value.

    Operator-only modules are skipped, for references and for the guard:
    revision modules and standalone scripts (a ``__main__`` block that starts
    no server) that no other scanned module imports or names in a string.

    The guard: one construct that can reach a table without naming it (see
    ``_visit``) voids every signal of the run.
    """

    def __init__(self, walker, others, root):
        self.walker = walker
        self.void = False
        self.classes = {}  # a target's ClassDef -> its symbol
        self.own = set()  # ids of a Table() target's own binding name and name argument
        self.targets = self._targets()
        # token -> where it is named: a target's ClassDef, or None for anywhere else.
        self.idents = {symbol: set() for _, symbol, _ in self.targets}
        self.words = {word.lower(): set() for table, symbol, _ in self.targets for word in (symbol, table[2])}
        self.modules = {name for rel in walker.trees for name in _dotted_suffixes(rel)}
        operator_only = self._operator_only()
        for rel, tree in walker.trees.items():
            if rel not in operator_only:
                self._read(rel, tree)
        names = {table[2].lower() for table, _, _ in self.targets}
        for rel in others:
            # latin-1 maps every byte to one character, so ASCII words survive any encoding.
            text = (root / rel).read_bytes().decode("latin-1").lower()
            for name in names.intersection(WORD.findall(text)):
                self.words[name].add(None)

    def _targets(self):
        """``(table, symbol, definition)`` for each table a signal can name, in table order.

        A declarative class goes by its simple name. A ``Table()`` call goes by
        the one module-level name bound to it, and only when no other table
        shares its table name: its signal carries the bare name. A symbol or
        table name that is not a plain ASCII word is left out.
        """
        walker = self.walker
        named = Counter(table[2] for table in walker.tables)
        found = []
        for table in sorted(set(walker.tables), key=_table_key):
            rel, qname, name = table
            if qname is not None:
                node = next(rec.node for rec in walker.indexes[rel].classes if rec.qname == qname)
                symbol, own = qname.rsplit(".", 1)[-1], ()
            elif named[name] == 1:
                node = next(call["node"] for call in walker.indexes[rel].table_calls if call["table_name"] == name)
                bound = [
                    stmt.targets[0]
                    for stmt in walker.trees[rel].body
                    if isinstance(stmt, ast.Assign)
                    and stmt.value is node
                    and len(stmt.targets) == 1
                    and isinstance(stmt.targets[0], ast.Name)
                ]
                if not bound or walker.module_bound[rel][bound[0].id] != 1:
                    continue
                symbol, own = bound[0].id, (id(bound[0]), id(node.args[0]))
            else:
                continue
            if WORD.fullmatch(symbol) is None or WORD.fullmatch(name) is None:
                continue
            if qname is not None:
                self.classes[node] = symbol
            self.own.update(own)
            found.append((table, symbol, node))
        return found

    def _operator_only(self):
        """Revision modules and standalone scripts that no other module imports or names in a string."""
        walker = self.walker
        candidates = {
            rel: _dotted_suffixes(rel)
            for rel, tree in walker.trees.items()
            if _has_revision(tree)
            or any(walker._entry_bodies("maintenance-command", rel, tree, stmt) is not None for stmt in tree.body)
        }
        namers = {name: set() for names in candidates.values() for name in names}
        for rel, tree in walker.trees.items():
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom, ast.Constant)):
                    for name in _importable(node):
                        _note(namers, name, rel)
        return {rel for rel, names in candidates.items() if not any(namers[name] - {rel} for name in names)}

    def _read(self, rel, tree):
        """Notes one serving module's names and string words, each with the target class it sits in."""
        stack = [(stmt, None) for stmt in tree.body if not _binds_all(stmt)]
        while stack:
            node, region = stack.pop()
            if id(node) in self.own or (isinstance(node, ast.Expr) and _str_const(node.value) is not None):
                continue
            decorators = getattr(node, "decorator_list", [])
            if region is None and node in self.classes:
                # A decorator hands the class to other code, which then holds it unnamed.
                if decorators:
                    self.idents[self.classes[node]].add(None)
                stack.extend((child, None if child in decorators else node) for child in ast.iter_child_nodes(node))
                continue
            if region is not None and not all(_inert_decorator(dec) for dec in decorators):
                # The same for a method: its body may build the class's rows without a name.
                self.idents[self.classes[region]].add(None)
            self._visit(rel, node, region)
            stack.extend((child, region) for child in ast.iter_child_nodes(node))

    def _visit(self, rel, node, region):
        """Notes the reference one node makes; sets ``void`` when it can reach a table unnamed."""
        text = _str_const(node)
        if isinstance(node, ast.Name):
            _note(self.idents, node.id, region)
        elif isinstance(node, ast.Attribute):
            _note(self.idents, node.attr, region)
            if node.attr in REGISTRY_ATTRS or (node.attr == "tables" and _final_name(node.value) == "metadata"):
                self.void = True
        elif isinstance(node, ast.alias) and node.asname is not None:
            # ``from models import Row as R``: the uses then say ``R``, never ``Row``.
            _note(self.idents, node.name, region)
        elif isinstance(node, ast.Call) and self._computed_lookup(rel, node):
            self.void = True
        elif text is not None:
            for word in WORD.findall(text.lower()):
                _note(self.words, word, region)
        if isinstance(node, (ast.Constant, ast.JoinedStr, ast.BinOp)) and COMPUTED_WRITE.match(_template(node)):
            self.void = True

    def _computed_lookup(self, rel, call):
        """True for ``table(<non-literal>)``, ``Table(<non-literal>, ...)`` and ``getattr(<scanned module>, <non-literal>)``."""
        func, args = call.func, call.args
        if _final_name(func) in ("table", "Table"):
            return bool(args) and _str_const(args[0]) is None
        if not (isinstance(func, ast.Name) and func.id == "getattr" and len(args) >= 2 and isinstance(args[0], ast.Name)):
            return False
        ref = self.walker.indexes[rel].imports.get(args[0].id)
        if ref is None or _str_const(args[1]) is not None:
            return False
        module = ref.module if ref.name is None else f"{ref.module}.{ref.name}".lstrip(".")
        return module in self.modules

    def signals(self):
        """One signal per target nothing names, at its definition; none when the run is void."""
        if self.void:
            return []
        out = []
        for table, symbol, node in self.targets:
            named = self.idents[symbol] | self.words[symbol.lower()] | self.words[table[2].lower()]
            if not named - {node}:
                out.append(_table_signal(table, "unreferenced", loc(table[0], node)))
        return out
