"""Code-derived internal reachability for SQLAlchemy tables (P3 i).

A table is internal for an entry-point category when an entry point of that
category reaches a writer of the table. Every list below is closed: a shape
that is not named gives no edge and no writer, and so no signal.

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


def reachability_signals(indexes, trees, tables, categories):
    """Derives one ``internality`` signal per (table, entry category) reached.

    Args:
        indexes: ``{relpath: FileIndex}`` for every scanned, non-test file.
        trees: ``{relpath: ast.Module}``, the same files as ``indexes``.
        tables: ``[(relpath, class_qname_or_None, table_name)]`` for every
            table resource: a declarative class (qname set) or a ``Table()``
            call (qname None).
        categories: The entry-point categories to derive, a subset of
            ``migration``, ``maintenance-command`` and ``worker``.

    Returns:
        list[dict]: ``ClassificationSignal`` documents (unsorted).
    """
    return _Walker(indexes, trees, tables).signals(categories)


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

    def _table_of(self, rel, node):
        """The table an expression denotes: a model, ``M.__table__``, or ``table("lit")``."""
        if isinstance(node, ast.Name):
            return self._class_table(rel, node.id)
        if isinstance(node, ast.Attribute) and node.attr == "__table__" and isinstance(node.value, ast.Name):
            return self._class_table(rel, node.value.id)
        if isinstance(node, ast.Call) and self._sa_symbol(rel, node.func) == "table" and node.args:
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

    def _is_session_ctor(self, rel, node):
        if not isinstance(node, ast.Call):
            return False
        if self._sa_symbol(rel, node.func) == "Session":
            return True
        return (
            isinstance(node.func, ast.Call)
            and self._sa_symbol(rel, node.func.func) == "sessionmaker"
        )

    def _is_session_receiver(self, rel, own, fn, name):
        """True when ``name`` is bound exactly once in the scope, to a session."""
        params = [p for p in _param_nodes(fn) if p.arg == name]
        if len(params) + _bound_count(own, name) != 1:
            return False
        if params:
            annotation = params[0].annotation
            return annotation is not None and self._sa_symbol(rel, annotation) == "Session"
        source = _binding_source(own, name)
        return source is not None and self._is_session_ctor(rel, source)

    def _writes(self, rel, own, fn, call):
        """The tables one call writes, as a list of table tuples."""
        symbol = self._sa_symbol(rel, call.func, own, fn)
        if symbol is not None:
            return self._sa_writes(rel, symbol, call)
        if isinstance(call.func, ast.Attribute):
            return self._method_writes(rel, own, fn, call)
        return []

    def _sa_writes(self, rel, symbol, call):
        """Writes made by a sqlalchemy-imported call: ``insert(X)`` and ``text(S)``."""
        if symbol in WRITE_CALLS and call.args:
            return _listed(self._table_of(rel, call.args[0]))
        if symbol == "text" and call.args:
            return self._literal_write(_str_const(call.args[0]))
        return []

    def _method_writes(self, rel, own, fn, call):
        """Writes made by a method call: ``X.__table__.insert()``, alembic ops and session adds."""
        func = call.func
        if func.attr in WRITE_CALLS and isinstance(func.value, ast.Attribute) and func.value.attr == "__table__":
            return _listed(self._table_of(rel, func.value))
        if not call.args:
            return []
        if func.attr == "bulk_insert" and self._is_alembic_op(rel, func.value):
            return _listed(self._table_of(rel, call.args[0]))
        if func.attr == "execute" and self._is_alembic_op(rel, func.value):
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

    def _closure(self, rel, stmts, fn):
        """The entry body plus every module-level body it reaches, in BFS order.

        Each body is ``(relpath, own_nodes, function_node_or_None)``.
        """
        bodies = [(rel, list(_own_nodes(stmts)), fn)]
        seen = set()
        if fn is not None:
            seen.add((rel, fn.name))
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

    def signals(self, categories):
        out = []
        for category in sorted(set(categories)):
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
