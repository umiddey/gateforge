"""AST-only FastAPI route discovery for Gateforge (GPP/3 detector).

Parses Python source with the stdlib ``ast`` module and reports FastAPI
server routes as ``http.contract`` evidence resources WITHOUT importing or
executing any application code (ADR 0004 D1; plan phase 2). Stdlib only
(Python >= 3.11); the GPP/3 serve loop lives in ``__main__.py``.

Detector vocabulary (frozen with the pack):

- Contract resources: ``kind`` ``http.contract`` (engine-owned
  evidence-only kind — never a business resource, never classified
  directly). Attributes carry ``role`` (always ``server-route`` here),
  ``method`` (one concrete verb per fact), ``rawPath`` (exactly as
  written), ``normalizedPath`` (empty here; canonicalized TypeScript-side
  by the pack wrapper so canonicalization has exactly one implementation),
  ``framework`` (``fastapi``), ``handlerSymbol``, ``isAsync``,
  ``responseModel``, ``requestSchemaSymbols``, ``tags``, ``operationId``,
  and ``mountProvenance`` (``include-chain`` or ``standalone``).
- One fact per (effective mounted path, concrete method): an
  ``api_route(methods=[...])`` yields one fact per listed method, and a
  router mounted twice yields one fact per mount (plan phase 2.3).
- Standalone routers (never the target of a resolvable ``include_router``)
  emit their routes at their own prefix with ``mountProvenance``
  ``standalone`` — matching the legacy wiring scanner's default mount.
- Registry functions (the ``def register_all_routers(app): ...
  app.include_router(r, prefix=...)`` pattern): a function whose body
  calls ``include_router`` on one of ITS OWN parameters collects those
  include edges keyed by the parameter. A call site whose argument
  resolves to a known ``FastAPI()``/``APIRouter()`` instance variable
  (same-file assignment — module-level or factory-local — or an import
  binding to another scanned file's instance) has the edges REWIRED onto
  that instance: the includes behave exactly as if written on the
  instance (mount provenance ``include-chain``, the include call's own
  source location, repeated mounts duplicate). Chaining is bounded:
  a registry function may pass its parameter to another helper
  (``def create_app(app): register_all_routers(app)``) up to
  ``MAX_RESOLUTION_DEPTH`` helper hops; beyond the bound the outcome is
  one typed unresolved entry naming the function where the chain still
  grows — never a silent drop, never a guess. A call site whose argument
  cannot be resolved to a known instance is a typed unresolved entry
  naming the exact call site, and emits NOTHING: the routers are
  provably included (their source carries prefixes), so prefix-less
  standalone paths would fabricate routes — the honest closed-world
  outcome is the blocking entry. The same applies to computed (non-Name)
  argument expressions. Parameter names that shadow a same-file instance
  variable keep the module-level reading only (no double emission).
- Package-attribute imports: ``from pkg import attr`` where
  ``pkg/attr.py`` does not exist resolves ``attr`` through the package's
  ``__init__.py`` module-level bindings — a router assignment
  (``router = APIRouter()``) or an import re-export
  (``from .endpoints import router``), followed up to
  ``MAX_RESOLUTION_DEPTH`` hops. Ambiguity flows into the existing typed
  unresolved entries (never a guess).
- Import roots: when the caller configures them (``scan(...,
  import_roots=[...])``, repo-root-relative directories that act as
  Python import roots, e.g. ``["backend"]``), ABSOLUTE imports resolve
  through them: ``from api.v1.endpoints import activities`` binds
  ``<importRoot>/api/v1/endpoints/activities.py`` (or its package
  ``__init__.py``), so centrally-registered routers join the mount graph
  with their real prefixes. Uniqueness is mandatory: a dotted module
  matching MORE THAN ONE scanned file across the roots is a typed
  unresolved entry (``FASTAPI_PREFIX_UNRESOLVED`` with an ambiguous-match
  detail) — never a guess. With import roots configured the absolute-
  import suffix heuristic is disabled (explicit roots govern); relative
  imports are unaffected. Without import roots every behavior is exactly
  as before (closed-world: back-compat).
- ``unresolved`` entries: ``FASTAPI_PREFIX_UNRESOLVED`` for computed
  router/include prefixes, unresolvable or ambiguous include
  targets/imports/aliases, unresolvable registry-function call-site
  arguments, include cycles, and registry chains beyond the helper-depth
  bound; ``HTTP_PATH_DYNAMIC`` for non-literal route paths;
  ``HTTP_METHOD_DYNAMIC`` for decorator verbs outside the supported set.
  All are source-located and blocking — nothing disappears silently.
- No app import, no route execution, no environment or network access
  (plan phase 2 anti-pattern guards).
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

PLUGIN_ID = "gateforge.pack-fastapi"
VERSION = "0.1.0"

CONTRACT_KIND = "http.contract"
FRAMEWORK = "fastapi"

# Typed outcome codes (mirrored in @gateforge/http-contract codes.ts).
FASTAPI_PREFIX_UNRESOLVED = "FASTAPI_PREFIX_UNRESOLVED"

_DECORATOR_METHODS = {
    "get": "GET",
    "post": "POST",
    "put": "PUT",
    "patch": "PATCH",
    "delete": "DELETE",
    "head": "HEAD",
    "options": "OPTIONS",
}

# HTTP verbs FastAPI supports that this pack deliberately does not map to
# the contract method set: decorated routes are reported as typed
# unresolved entries instead of silently vanishing.
_UNSUPPORTED_METHODS = {"trace": "TRACE"}

_PRIMITIVE_ANNOTATIONS = {
    "str", "int", "float", "bool", "bytes", "dict", "list", "set", "tuple",
    "Annotated", "Optional", "Union", "Any", "None",
}

# Bounded interprocedural expansion (documented, deterministic): how many
# helper hops a registry-function parameter may travel before the walk
# stops, and how many ``__init__.py`` import bindings one name may pass
# through. Beyond the bound the outcome is a typed unresolved entry —
# never a silent drop, never a guess.
MAX_RESOLUTION_DEPTH = 8


@dataclass
class RouteDef:
    """One route decorator on one handler function."""

    methods: list[str]           # concrete supported verbs (may be empty)
    path: str | None             # literal path, or None when computed
    node: ast.AST                # the decorator call (location anchor)
    handler: str                 # function name
    is_async: bool
    response_model: str | None
    request_schemas: list[str]
    tags: list[str]
    operation_id: str | None
    file: str = ""               # file the decorator lives in (survives alias merge)


@dataclass
class RouterDef:
    """One router-like variable: an ``APIRouter(...)`` or an import alias."""

    var: str
    prefix: str | None           # literal prefix ('' when absent; None when computed)
    prefix_node: ast.AST
    routes: list[RouteDef] = field(default_factory=list)
    # Set when the variable is an import alias bound to a router defined in
    # another scanned module: ``(raw_module, level, imported_name)``.
    alias_of: tuple[str | None, int, str] | None = None


@dataclass
class IncludeEdge:
    """One ``<owner>.include_router(<target>, prefix=...)`` call.

    ``owner_var`` is the owner expression's root name: an instance var, an
    import alias — or a registry function's PARAMETER (function-mediated
    includes; materialized onto a real instance by the resolver). ``file``
    is the file the call is written in; resolution and locations for the
    edge always use it (materialized edges keep their source file, not the
    mounted instance's file).
    """

    owner_var: str                       # owning router/app var (same file)
    target_var: str | None               # same-file Name target (var or alias)
    target_alias: tuple[str | None, int, str] | None  # Alias.attr target import ref
    target_attrs: list[str]              # attribute chain for alias targets (e.g. ['activities', 'router'])
    prefix: str | None                   # literal include prefix ('' absent; None computed)
    node: ast.AST
    file: str = ""                       # file the include call lives in


@dataclass
class FunctionIncludes:
    """One top-level function's registry-function record.

    ``param_edges`` maps a parameter name to the ``include_router`` edges
    whose owner expression is that parameter (the same edge objects that
    live in ``FileIndex.include_edges``, so identity-based dedup works
    across the bounded chaining passes). Empty for plain functions.
    """

    name: str
    node: ast.AST
    params: tuple[str, ...]              # positional parameters (call sites bind positionally)
    param_edges: dict[str, list[IncludeEdge]] = field(default_factory=dict)


@dataclass
class HelperCall:
    """One plain-name call carrying at least one positional Name argument.

    Recorded for every such call (module level or inside a top-level
    function); only calls whose callee resolves to a scanned function with
    include-bearing parameters ever participate in propagation.
    """

    callee: str                          # called function's name as written
    args: list[ast.AST]                  # positional argument expressions
    node: ast.AST                        # the call (typed-unresolved anchor)
    enclosing: str | None                # enclosing top-level function (None: module level)


@dataclass
class ImportResolution:
    """Outcome of resolving one import against the scanned set.

    ``module`` is the dotted scanned module (a ``module_map`` key) when
    uniquely resolved. ``ambiguous`` carries the matching scanned files
    when the import matches more than one — failure with proof, never a
    guess.
    """

    module: str | None = None
    ambiguous: tuple[str, ...] | None = None


@dataclass
class ImportRef:
    """One import binding usable for cross-file resolution."""

    module: str | None           # dotted module (absolute portion)
    name: str | None             # imported top-level name (None: alias is the module)
    level: int                   # relative-import depth (0: absolute)


@dataclass
class FileIndex:
    """Everything one parsed file contributes to the mount graph."""

    relpath: str
    routers: dict[str, RouterDef] = field(default_factory=dict)
    apps: set[str] = field(default_factory=set)
    imports: dict[str, ImportRef] = field(default_factory=dict)
    include_edges: list[IncludeEdge] = field(default_factory=list)
    functions: dict[str, FunctionIncludes] = field(default_factory=dict)
    helper_calls: list[HelperCall] = field(default_factory=list)
    unsupported: list[tuple[ast.AST, list[str]]] = field(default_factory=list)


def loc(relpath: str, node: ast.AST) -> dict:
    """Canonical location triple: 1-based line, 0-based col."""
    return {"file": relpath, "line": node.lineno, "col": getattr(node, "col_offset", 0)}


def _static_string(node: ast.AST | None) -> str | None:
    """A literal str constant, or None for anything computed."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _dotted_name(node: ast.AST | None) -> str | None:
    """A dotted name for Name/Attribute chains, or None."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted_name(node.value)
        return None if base is None else f"{base}.{node.attr}"
    return None


def _keyword(call: ast.Call, name: str) -> ast.AST | None:
    for keyword in call.keywords:
        if keyword.arg == name:
            return keyword.value
    return None


def _elements(node: ast.AST | None) -> list[ast.AST] | None:
    if isinstance(node, (ast.List, ast.Tuple)):
        return list(node.elts)
    return None


class _ModuleVisitor(ast.NodeVisitor):
    """Collects routers, apps, imports, include edges, and route decorators.

    Registry-function collection is top-level only (module or class-body
    ``def``); a nested ``def`` stays in the enclosing function's context so
    its ``include_router`` calls still count for the outer parameter.
    """

    def __init__(self, relpath: str) -> None:
        self.index = FileIndex(relpath=relpath)
        # Current top-level function (registry-function context), or None
        # at module level.
        self._function: FunctionIncludes | None = None

    # -- imports ------------------------------------------------------------

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.index.imports[alias.asname or alias.name.split(".")[0]] = ImportRef(
                module=alias.name, name=None, level=0,
            )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            self.index.imports[alias.asname or alias.name] = ImportRef(
                module=node.module, name=alias.name, level=node.level,
            )

    # -- router / app instances ---------------------------------------------

    def visit_Assign(self, node: ast.Assign) -> None:
        if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name):
            kind = node.value.func.id
            if kind in {"FastAPI", "APIRouter"}:
                for target in node.targets:
                    if not isinstance(target, ast.Name):
                        continue
                    if kind == "FastAPI":
                        self.index.apps.add(target.id)
                    else:
                        prefix_node = _keyword(node.value, "prefix")
                        prefix: str | None = (
                            "" if prefix_node is None else _static_string(prefix_node)
                        )
                        self.index.routers[target.id] = RouterDef(
                            var=target.id, prefix=prefix,
                            prefix_node=prefix_node if prefix_node is not None else node.value,
                        )
        self.generic_visit(node)

    # -- functions: route decorators -----------------------------------------

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_callable(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_callable(node, is_async=True)

    def _visit_callable(self, node, is_async: bool = False) -> None:
        for decorator in node.decorator_list:
            self._visit_route_decorator(decorator, node, is_async)
        if self._function is None:
            # Top-level callable: becomes the registry-function context.
            # Positional parameters only — call sites bind the app argument
            # positionally; the LAST def of a name wins (Python semantics).
            params = tuple(
                argument.arg for argument in (*node.args.posonlyargs, *node.args.args)
            )
            record = FunctionIncludes(name=node.name, node=node, params=params)
            self.index.functions[node.name] = record
            self._function = record
            self.generic_visit(node)  # visit_Call records includes everywhere
            self._function = None
        else:
            self.generic_visit(node)  # nested def: keep the enclosing context

    def visit_Call(self, node: ast.Call) -> None:
        self._visit_include_call(node)
        self._visit_helper_call(node)
        self.generic_visit(node)

    # -- detail walkers -------------------------------------------------------

    def _visit_helper_call(self, node: ast.Call) -> None:
        """Records plain-name calls with positional Name arguments.

        Bounded noise by construction: resolution only ever matches calls
        whose callee resolves to a scanned function carrying include-bearing
        parameters, so utility calls (``Depends(get_db)``, ``print(x)``)
        are recorded but never participate.
        """
        if not isinstance(node.func, ast.Name) or not node.args:
            return
        if not any(isinstance(argument, ast.Name) for argument in node.args):
            return
        self.index.helper_calls.append(
            HelperCall(
                callee=node.func.id,
                args=list(node.args),
                node=node,
                enclosing=self._function.name if self._function is not None else None,
            )
        )

    def _visit_route_decorator(self, node: ast.AST, fn, is_async: bool) -> None:
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            return
        owner = node.func.value
        if not isinstance(owner, ast.Name):
            return  # computed router expression: typed outcome, no guess
        method_attr = node.func.attr
        methods: list[str] = []
        if method_attr in _DECORATOR_METHODS:
            methods = [_DECORATOR_METHODS[method_attr]]
        elif method_attr in _UNSUPPORTED_METHODS:
            owner_ref = self.index.routers.get(owner.id)
            self.index.unsupported.append((
                node,
                [_UNSUPPORTED_METHODS[method_attr]],
            ))
            if owner_ref is not None:
                owner_ref.routes.append(RouteDef(
                    methods=[], path=None, node=node, file=self.index.relpath, handler=fn.name,
                    is_async=is_async, response_model=None, request_schemas=[],
                    tags=[], operation_id=None,
                ))
            return
        elif method_attr == "api_route":
            for element in (_elements(_keyword(node, "methods")) or []):
                verb = _static_string(element)
                if verb is not None:
                    methods.append(verb.upper())
        if not methods:
            return
        path = _static_string(node.args[0]) if node.args else None
        entry = RouteDef(
            methods=methods,
            path=path,
            node=node,
            file=self.index.relpath,
            handler=fn.name,
            is_async=is_async,
            response_model=_dotted_name(_keyword(node, "response_model")),
            request_schemas=_request_schema_names(fn, path),
            tags=[
                s for s in (
                    _static_string(e) for e in (_elements(_keyword(node, "tags")) or [])
                ) if s is not None
            ],
            operation_id=_static_string(_keyword(node, "operation_id")),
        )
        router = self.index.routers.get(owner.id)
        if router is None:
            ref = self.index.imports.get(owner.id)
            alias_of = None
            if ref is not None and ref.name is not None:
                alias_of = (ref.module, ref.level, ref.name)
            router = RouterDef(var=owner.id, prefix="", prefix_node=owner, alias_of=alias_of)
            self.index.routers[owner.id] = router
        router.routes.append(entry)
        out_of_set = [m for m in methods if m not in _DECORATOR_METHODS.values()]
        if out_of_set:
            self.index.unsupported.append((node, out_of_set))

    def _visit_include_call(self, node: ast.Call) -> None:
        if not isinstance(node.func, ast.Attribute) or node.func.attr != "include_router":
            return
        if not isinstance(node.func.value, ast.Name) or not node.args:
            return
        owner = node.func.value.id
        target = node.args[0]
        target_var: str | None = None
        target_alias: tuple[str | None, int, str] | None = None
        target_attrs: list[str] = []
        if isinstance(target, ast.Name):
            target_var = target.id  # same-file var or import alias
        elif isinstance(target, ast.Attribute):
            # Attribute chains over an import binding: ``items.router``,
            # or the deeper registry shape ``endpoints.health.router``.
            attrs: list[str] = []
            base: ast.AST = target
            while isinstance(base, ast.Attribute):
                attrs.append(base.attr)
                base = base.value
            if isinstance(base, ast.Name):
                attrs.reverse()
                ref = self.index.imports.get(base.id)
                if ref is not None and ref.name is not None:
                    target_alias = (ref.module, ref.level, ref.name)
                    target_attrs = attrs
        prefix_node = _keyword(node, "prefix")
        edge = IncludeEdge(
            owner_var=owner,
            target_var=target_var,
            target_alias=target_alias,
            target_attrs=target_attrs,
            prefix="" if prefix_node is None else _static_string(prefix_node),
            node=node,
            file=self.index.relpath,
        )
        self.index.include_edges.append(edge)
        if (
            self._function is not None
            and owner in self._function.params
        ):
            # Function-mediated include (the registry-function pattern).
            # The same edge object also lives in include_edges, so the
            # target stays provably-included (suppressed from standalone
            # emission) whether or not the parameter ever resolves.
            self._function.param_edges.setdefault(owner, []).append(edge)


def _request_schema_names(fn, path: str | None) -> list[str]:
    """Top-level annotation names of non-primitive, non-path parameters."""
    path_params: set[str] = set()
    if path:
        for segment in path.split("{")[1:]:
            if "}" in segment:
                path_params.add(segment.split("}")[0].split(":")[0])
    names: list[str] = []
    for arg in list(fn.args.args) + list(fn.args.kwonlyargs):
        if arg.annotation is None or arg.arg in path_params:
            continue
        name = _dotted_name(arg.annotation)
        if name is None:
            continue
        if name.split(".")[0] in _PRIMITIVE_ANNOTATIONS:
            continue
        if "Depends" in name:
            continue
        if name not in names:
            names.append(name)
    return names


def _scan_file(relpath: str, root: Path) -> tuple[FileIndex | None, dict | None]:
    """Parse one repo-relative file into its index, or a PARSE_ERROR finding.

    Read errors propagate (the serve loop surfaces them as a plugin error
    frame); only syntax failures become findings — a file that cannot be
    parsed must never read as scanned-and-empty.
    """
    try:
        source = (root / relpath).read_text(encoding="utf-8")
        tree = ast.parse(source, filename=relpath)
    except (SyntaxError, ValueError, UnicodeDecodeError) as exc:
        line = getattr(exc, "lineno", 0) or 0
        msg = exc.msg if isinstance(exc, SyntaxError) else str(exc)
        return None, {
            "code": "PARSE_ERROR",
            "detail": f"{type(exc).__name__}: {msg}",
            "locations": [{"file": relpath, "line": max(line, 1), "col": 0}],
        }
    visitor = _ModuleVisitor(relpath)
    visitor.visit(tree)
    return visitor.index, None


def _normalize_path(rel: str) -> str:
    """Validate + normalize a repo-root-relative path (fail closed)."""
    path = rel.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if path == "" or path.startswith("/"):
        raise ValueError(f"target must be a repo-root-relative path, got {rel!r}")
    if ".." in path.split("/"):
        raise ValueError(f"target must be a repo-root-relative path, got {rel!r}")
    return path


def _module_of(relpath: str) -> str:
    """Dotted module name of a scanned file (``__init__.py`` = package)."""
    without_ext = relpath[:-3] if relpath.endswith(".py") else relpath
    if without_ext.endswith("/__init__"):
        without_ext = without_ext[: -len("/__init__")]
    return without_ext.replace("/", ".")


def _root_candidates(dotted: str, import_roots: tuple[str, ...], scanned: frozenset[str]) -> list[str]:
    """Scanned files a dotted module name maps to under the import roots.

    ``api.v1.activities`` under root ``backend`` matches the scanned files
    ``backend/api/v1/activities.py`` and ``backend/api/v1/activities/
    __init__.py`` when present. Deterministic: root order, then module
    file before package; duplicates removed.
    """
    relative = dotted.replace(".", "/")
    matches: list[str] = []
    for root in import_roots:
        base = f"{root}/{relative}" if root else relative
        for candidate in (f"{base}.py", f"{base}/__init__.py"):
            if candidate in scanned and candidate not in matches:
                matches.append(candidate)
    return matches


def _resolve_import(
    file_relpath: str,
    ref: tuple[str | None, int, str],
    module_map: dict[str, str],
    import_roots: tuple[str, ...] = (),
    scanned: frozenset[str] = frozenset(),
    prefer_name: bool = False,
) -> ImportResolution:
    """Resolve an import to one scanned module, or prove why not.

    Args:
        file_relpath: Repo-relative importing file.
        ref: Parsed import tuple ``(module, relative-level, imported-name)``.
        module_map: Dotted module names available in the scanned set.
        import_roots: Configured repo-root-relative import roots. When
            non-empty, ABSOLUTE imports resolve through them and the
            suffix heuristic is skipped; relative imports are unchanged.
        scanned: Repo-relative scanned file set (required for roots).
        prefer_name: Check ``module.name`` before ``module`` (used by the
            module-import attribute chain, where the imported name is a
            submodule: ``from api.v1 import activities``).

    Returns:
        ImportResolution: the unique module, an ambiguity proof, or an
        unresolved outcome — never a guess.
    """
    raw_module, level, name = ref
    parts = _module_of(file_relpath).split(".")
    if level > 0:
        # Relative imports resolve inside the scanned tree itself; import
        # roots do not participate.
        up = level - 1
        parts = parts[: len(parts) - up] if up > 0 else parts
        if raw_module:
            parts.extend(raw_module.split("."))
        candidate = ".".join(parts)
        if candidate in module_map:
            return ImportResolution(module=candidate)
        with_name = f"{candidate}.{name}" if name else candidate
        if with_name in module_map:
            return ImportResolution(module=with_name)

        # Applications often run with a package directory on PYTHONPATH, so
        # imports such as ``from api.v1.routes`` resolve to ``backend.api.v1.routes``
        # when the repository is scanned from its parent directory. Accept only a
        # unique suffix match; ambiguity remains fail-closed.
        suffix = f".{candidate}" if candidate else ""
        matches = sorted(module for module in module_map if suffix and module.endswith(suffix))
        if len(matches) == 1:
            return ImportResolution(module=matches[0])
        with_name_suffix = f".{with_name}" if with_name else ""
        matches = sorted(module for module in module_map if with_name_suffix and module.endswith(with_name_suffix))
        return ImportResolution(module=matches[0] if len(matches) == 1 else None)

    candidate = raw_module or ""
    with_name = f"{candidate}.{name}" if name else candidate

    if not import_roots:
        # Legacy behavior (import roots not configured): exact match, then
        # the unique-suffix heuristic — byte-identical to pre-roots releases.
        if candidate in module_map:
            return ImportResolution(module=candidate)
        if with_name in module_map:
            return ImportResolution(module=with_name)
        suffix = f".{candidate}" if candidate else ""
        matches = sorted(module for module in module_map if suffix and module.endswith(suffix))
        if len(matches) == 1:
            return ImportResolution(module=matches[0])
        with_name_suffix = f".{with_name}" if with_name else ""
        matches = sorted(module for module in module_map if with_name_suffix and module.endswith(with_name_suffix))
        return ImportResolution(module=matches[0] if len(matches) == 1 else None)

    # Explicit import roots: the two readings of the import, tried in order
    # (the imported name first when it is itself the target module).
    interpretations = (with_name, candidate) if prefer_name else (candidate, with_name)
    for dotted in interpretations:
        if dotted and dotted in module_map:
            return ImportResolution(module=dotted)
    for dotted in interpretations:
        if not dotted:
            continue
        matches = _root_candidates(dotted, import_roots, scanned)
        if len(matches) == 1:
            return ImportResolution(module=_module_of(matches[0]))
        if len(matches) > 1:
            return ImportResolution(ambiguous=tuple(sorted(matches)))
    return ImportResolution(module=None)


class _Resolver:
    """Composes effective mounted paths over the cross-file mount graph."""

    def __init__(self, indexes: dict[str, FileIndex], import_roots: tuple[str, ...] = ()) -> None:
        self.indexes = indexes
        self.import_roots = import_roots
        self.scanned: frozenset[str] = frozenset(indexes)
        self.module_map = {_module_of(rel): rel for rel in indexes}
        self.facts: list[dict] = []
        self.unresolved: list[dict] = []

    def resolve(self) -> None:
        self._materialize_function_includes()
        self._merge_aliases()
        included = self._collect_included()
        for relpath in sorted(self.indexes):
            index = self.indexes[relpath]
            for var in sorted(index.apps):
                self._walk(relpath, var, "", (), "include-chain", included)
            for name in sorted(index.routers):
                router = index.routers[name]
                if router.alias_of is not None:
                    continue  # merged into the defining router; no double emission
                if name in index.apps:
                    continue  # app-owned routes emit through the apps loop
                if (relpath, name) in included:
                    continue
                self._walk(relpath, name, "", (), "standalone", included)

    def _materialize_function_includes(self) -> None:
        """Rewires registry-function includes onto real instances.

        Interprocedural, bounded, deterministic:

        1. Every top-level function of every scanned file joins the global
           registry keyed ``(file, name)``; its ``param_edges`` (includes
           written on its own parameters) seed the effective edge sets.
        2. Bounded chaining (snapshot fixed point, at most
           ``MAX_RESOLUTION_DEPTH`` applied passes — after pass k a
           parameter k helper hops from the include is complete; one extra
           probe pass detects growth beyond the bound): when a function's
           body calls another scanned function with one of ITS OWN
           parameters as a positional argument, the callee's effective
           edges re-key onto that parameter (identity-deduped, so cycles
           and re-visits add nothing). Growth the probe pass still finds
           is a chain deeper than the bound: one typed unresolved entry
           naming the function where the chain still grows.
        3. Every recorded call site of an include-bearing function is
           materialized: each positional argument that resolves to a known
           instance (``_instance_owner``) receives the corresponding edges
           as ordinary include edges on that instance — same provenance
           discipline as written includes (mount ``include-chain`` at the
           include call's own source location; repeated mounts duplicate).
           Arguments bound to the enclosing function's own parameter were
           already handled by chaining and materialize at the outer call
           site instead.

        Unresolvable arguments (a Name bound to no known instance, or a
        computed expression) yield a typed unresolved entry naming the
        exact call site and materialize NOTHING: the routers are provably
        included somewhere (they stay suppressed from standalone emission)
        and their source carries prefixes, so emitting prefix-less paths
        would fabricate routes. A parameter name shadowing a same-file
        instance variable keeps the module-level reading only (the edge is
        already walked from the instance; materializing would double-emit).
        """
        registry: dict[tuple[str, str], FunctionIncludes] = {
            (relpath, name): function
            for relpath, index in sorted(self.indexes.items())
            for name, function in index.functions.items()
        }
        if not registry:
            return

        def resolve_fn(relpath: str, callee: str) -> tuple[str, str] | None:
            """(file, function) a plain callee name denotes, or None.

            Same-file top-level def first, then an import binding resolved
            against the scanned set (deterministic import resolution;
            ambiguity or absence returns None — a plain unknown call makes
            no claim).
            """
            if callee in self.indexes[relpath].functions:
                return (relpath, callee)
            ref = self.indexes[relpath].imports.get(callee)
            if ref is None or ref.name is None:
                return None
            resolution = _resolve_import(
                relpath, (ref.module, ref.level, ref.name),
                self.module_map, self.import_roots, self.scanned,
            )
            if resolution.module is None:
                return None
            target = self.module_map.get(resolution.module)
            if target is not None and ref.name in self.indexes[target].functions:
                return (target, ref.name)
            return None

        # Effective per-parameter edges, snapshot-propagated (each pass
        # reads only the previous pass's state, so a parameter k helper
        # hops from its include is complete after pass k).
        effective: dict[tuple[str, str], dict[str, list[IncludeEdge]]] = {
            key: {param: list(edges) for param, edges in function.param_edges.items()}
            for key, function in registry.items()
        }
        unconverged: set[tuple[str, str]] = set()
        converged = False
        for _pass in range(MAX_RESOLUTION_DEPTH + 1):
            additions: list[tuple[tuple[str, str], str, IncludeEdge]] = []
            for relpath in sorted(self.indexes):
                index = self.indexes[relpath]
                for call in index.helper_calls:
                    if call.enclosing is None:
                        continue  # chaining concerns parameter-carrying functions only
                    fn_key = (relpath, call.enclosing)
                    function = registry.get(fn_key)
                    if function is None:
                        continue
                    helper_key = resolve_fn(relpath, call.callee)
                    if helper_key is None or helper_key == fn_key:
                        continue
                    helper_params = registry[helper_key].params
                    for position, param in enumerate(helper_params):
                        if position >= len(call.args):
                            break
                        argument = call.args[position]
                        if not isinstance(argument, ast.Name):
                            continue
                        if argument.id not in function.params:
                            continue
                        if argument.id in index.apps or argument.id in index.routers:
                            continue  # shadowed param: the module-level instance governs
                        bucket = effective[fn_key].setdefault(argument.id, [])
                        for edge in effective.get(helper_key, {}).get(param, []):
                            if not any(existing is edge for existing in bucket):
                                additions.append((fn_key, argument.id, edge))
            if not additions:
                converged = True
                break
            if _pass >= MAX_RESOLUTION_DEPTH:
                # Probe pass (never applied): growth here needs more than
                # MAX_RESOLUTION_DEPTH helper hops — beyond the bound.
                unconverged = {fn_key for fn_key, _param, _edge in additions}
                break
            grew: set[tuple[str, str]] = set()
            for fn_key, param, edge in additions:
                bucket = effective[fn_key].setdefault(param, [])
                if not any(existing is edge for existing in bucket):
                    bucket.append(edge)
                    grew.add(fn_key)
            unconverged = grew
        if not converged:
            # Still growing after the last pass: chains deeper than the bound.
            for relpath, name in sorted(unconverged):
                function = self.indexes[relpath].functions.get(name)
                if function is None:
                    continue
                self.unresolved.append({
                    "code": FASTAPI_PREFIX_UNRESOLVED,
                    "detail": (
                        f"registry-function include chain through '{name}' in {relpath} "
                        f"exceeds the supported helper depth ({MAX_RESOLUTION_DEPTH}); "
                        "the effective mount graph cannot be proven statically"
                    ),
                    "location": loc(relpath, function.node),
                })

        # Materialize every call site whose argument resolves to a known
        # instance (module level or inside a function — the factory shape).
        for relpath in sorted(self.indexes):
            for call in self.indexes[relpath].helper_calls:
                helper_key = resolve_fn(relpath, call.callee)
                if helper_key is None:
                    continue
                for position, param in enumerate(registry[helper_key].params):
                    if position >= len(call.args):
                        break
                    edges = effective.get(helper_key, {}).get(param)
                    if edges:
                        self._materialize_call(
                            relpath, call, call.args[position], edges, helper_key,
                        )

    def _materialize_call(
        self,
        relpath: str,
        call: HelperCall,
        argument: ast.AST,
        edges: list[IncludeEdge],
        helper_key: tuple[str, str],
    ) -> None:
        """Mounts one call site's edges onto the instance the argument names.

        See ``_materialize_function_includes`` for the semantics; this is
        the per-argument decision point (chaining passthrough, instance
        rewiring, or the typed unresolvable outcome).
        """
        enclosing = (
            self.indexes[relpath].functions.get(call.enclosing)
            if call.enclosing is not None
            else None
        )
        if isinstance(argument, ast.Name):
            if enclosing is not None and argument.id in enclosing.params:
                return  # chaining passthrough; materialized at the outer call site
            owner = self._instance_owner(relpath, argument.id)
            if owner is not None:
                target_file, owner_var = owner
                self.indexes[target_file].include_edges.extend(
                    IncludeEdge(
                        owner_var=owner_var,
                        target_var=edge.target_var,
                        target_alias=edge.target_alias,
                        target_attrs=list(edge.target_attrs),
                        prefix=edge.prefix,
                        node=edge.node,
                        file=edge.file,
                    )
                    for edge in edges
                )
                return
            self.unresolved.append({
                "code": FASTAPI_PREFIX_UNRESOLVED,
                "detail": (
                    f"call to registry function '{helper_key[1]}' in {relpath} passes "
                    f"'{argument.id}', which cannot be resolved to a known "
                    "FastAPI/APIRouter instance; its include_router calls cannot be "
                    "mounted and emit nothing (no prefix-less standalone paths are "
                    "fabricated)"
                ),
                "location": loc(relpath, call.node),
            })
            return
        self.unresolved.append({
            "code": FASTAPI_PREFIX_UNRESOLVED,
            "detail": (
                f"call to registry function '{helper_key[1]}' in {relpath} passes a "
                "computed argument expression, which cannot be resolved to a known "
                "FastAPI/APIRouter instance; its include_router calls cannot be "
                "mounted and emit nothing"
            ),
            "location": loc(relpath, call.node),
        })

    def _instance_owner(self, relpath: str, name: str) -> tuple[str, str] | None:
        """(file, var) when ``name`` denotes a known FastAPI/APIRouter instance.

        Same-file assignments first (module-level or factory-local — both
        are walked as instances), then an import binding whose target
        module declares the name as an instance (both readings of the
        import, like include-target resolution; ambiguity returns None).
        """
        index = self.indexes[relpath]
        if name in index.apps or name in index.routers:
            return (relpath, name)
        ref = index.imports.get(name)
        if ref is None or ref.name is None:
            return None
        parsed = (ref.module, ref.level, ref.name)
        for prefer_name in (False, True):
            resolution = _resolve_import(
                relpath, parsed, self.module_map, self.import_roots, self.scanned,
                prefer_name=prefer_name,
            )
            target = self.module_map.get(resolution.module) if resolution.module else None
            if target is not None and (
                ref.name in self.indexes[target].apps
                or ref.name in self.indexes[target].routers
            ):
                return (target, ref.name)
        return None

    def _merge_aliases(self) -> None:
        """Routes declared through import-aliased names join the defining
        router (one router object, many local names). Bounded passes also
        collapse alias chains; unresolvable aliases keep their routes so
        the walk reports them instead of losing them."""
        pending = sorted(
            (relpath, name)
            for relpath, index in self.indexes.items()
            for name, router in index.routers.items()
            if router.alias_of is not None
        )
        for _ in range(len(pending) + 1):
            changed = False
            for relpath, name in pending:
                router = self.indexes[relpath].routers.get(name)
                if router is None or router.alias_of is None or not router.routes:
                    continue
                target = self._module_router(relpath, router.alias_of, router.alias_of[2])
                if target is None:
                    continue
                target_file, target_var = target
                self.indexes[target_file].routers[target_var].routes.extend(router.routes)
                router.routes = []
                changed = True
            if not changed:
                return

    def _collect_included(self) -> set[tuple[str, str]]:
        """(file, var) pairs that are the target of a resolvable include."""
        targets: set[tuple[str, str]] = set()
        for relpath in sorted(self.indexes):
            for edge in self.indexes[relpath].include_edges:
                found, _ = self._resolve_target(edge.file or relpath, edge)
                if found is not None:
                    targets.add(found)
        return targets

    def _resolve_target(
        self, relpath: str, edge: IncludeEdge,
    ) -> tuple[tuple[str, str] | None, ImportResolution | None]:
        """(file, router var) an include edge points at, or None.

        The second element carries the import resolution when AMBIGUITY
        (not mere absence) caused the failure, so the walk can report the
        matching files instead of a bare "cannot be resolved".
        """
        if edge.target_var is not None:
            if edge.target_var in self.indexes[relpath].routers:
                return (relpath, edge.target_var), None
            ref = self.indexes[relpath].imports.get(edge.target_var)
            if ref is None:
                return None, None
            return self._module_router_ex(relpath, (ref.module, ref.level, ref.name), ref.name)
        if edge.target_alias is not None and edge.target_attrs:
            return self._resolve_alias_target(relpath, edge)
        return None, None

    def _resolve_alias_target(
        self, relpath: str, edge: IncludeEdge,
    ) -> tuple[tuple[str, str] | None, ImportResolution | None]:
        """Resolve ``<binding>.<attr chain>`` include targets.

        ``from a import items`` + ``items.router`` is the one-attribute
        shape; ``from api.v1 import endpoints`` + ``endpoints.health.router``
        walks intermediate submodules. With import roots configured, the
        imported NAME may itself be the target module (``from api.v1 import
        activities`` + ``activities.router``): a second resolution with the
        name-qualified module covers that reading. Ambiguity is returned as
        proof — never guessed.
        """
        ref = edge.target_alias
        assert ref is not None
        attrs = edge.target_attrs
        if not self.import_roots and len(attrs) != 1:
            return None, None  # pre-roots behavior: deep chains stay unresolved
        resolution = _resolve_import(relpath, ref, self.module_map, self.import_roots, self.scanned)
        if resolution.module is not None:
            found = self._alias_target_from(resolution.module, attrs)
            if found is not None:
                return found, None
        if not self.import_roots:
            return None, None  # pre-roots behavior: single reading, no retry
        retry = _resolve_import(
            relpath, ref, self.module_map, self.import_roots, self.scanned, prefer_name=True,
        )
        if retry.module is not None and retry.module != resolution.module:
            found = self._alias_target_from(retry.module, attrs)
            if found is not None:
                return found, None
        ambiguous = resolution.ambiguous if resolution.ambiguous is not None else retry.ambiguous
        return None, (ImportResolution(ambiguous=ambiguous) if ambiguous is not None else None)

    def _alias_target_from(self, module: str, attrs: list[str]) -> tuple[str, str] | None:
        """(file, var) for ``<module>.<attr chain>``, or None.

        Intermediate attributes must be scanned submodules; the final
        attribute is either a submodule whose ``router`` variable is a
        router (``pkg.router`` shape) or a router variable of the current
        module (``items`` of ``from a import items`` + ``items`` as a
        plain router object is handled by the Name branch).
        """
        for attr in attrs[:-1]:
            sub = self.module_map.get(f"{module}.{attr}")
            if sub is None:
                return None
            module = f"{module}.{attr}"
        final = attrs[-1]
        # ``from a import items`` + ``items.router``: try a.items first.
        target_file = self.module_map.get(f"{module}.{final}")
        if target_file is not None and "router" in self.indexes[target_file].routers:
            return (target_file, "router")
        current = self.module_map.get(module)
        if current is not None and final in self.indexes[current].routers:
            return (current, final)
        if current is not None:
            # ``pkg.attr`` where attr is a package-attribute binding
            # (``__init__.py`` assignment or re-export).
            return self._module_binding_target(module, final)
        return None

    def _module_router(
        self, relpath: str, ref: tuple[str | None, int, str], var: str,
    ) -> tuple[str, str] | None:
        """(file, var) for an imported router name, or None."""
        target, _ = self._module_router_ex(relpath, ref, var)
        return target

    def _module_router_ex(
        self, relpath: str, ref: tuple[str | None, int, str], var: str,
    ) -> tuple[tuple[str, str] | None, ImportResolution | None]:
        """(file, var) for an imported router name plus its resolution.

        The imported name resolves through the target module's own
        module-level bindings when it is not itself a router var or
        submodule: a package ``__init__.py`` re-export
        (``from pkg import router`` where the package does
        ``from .endpoints import router``) is followed, bounded by
        ``MAX_RESOLUTION_DEPTH`` hops. Ambiguity is returned as proof —
        never guessed.
        """
        resolution = _resolve_import(relpath, ref, self.module_map, self.import_roots, self.scanned)
        if resolution.module is None:
            return None, resolution
        target = self._module_binding_target(resolution.module, var)
        if target is not None:
            return target, resolution
        return None, resolution

    def _module_binding_target(
        self, module: str, var: str, depth: int = 0,
    ) -> tuple[str, str] | None:
        """(file, var) for module member ``var``, following bindings.

        In order: a scanned submodule ``<module>.<var>`` whose ``var`` is a
        router (the module-of-same-name shape), a router var of the module
        itself (``var = APIRouter()`` — e.g. in a package ``__init__.py``),
        then a module-level import binding of the module
        (``from .endpoints import router``) followed recursively. Bounded;
        cycles return None (typed unresolved at the caller, as before).
        """
        if depth > MAX_RESOLUTION_DEPTH:
            return None
        target_file = self.module_map.get(f"{module}.{var}") or self.module_map.get(module)
        if target_file is None:
            return None
        index = self.indexes[target_file]
        if var in index.routers:
            return (target_file, var)
        ref = index.imports.get(var)
        if ref is None or ref.name is None:
            return None
        resolution = _resolve_import(
            target_file, (ref.module, ref.level, ref.name),
            self.module_map, self.import_roots, self.scanned,
        )
        if resolution.module is None:
            return None
        return self._module_binding_target(resolution.module, ref.name, depth + 1)

    def _walk(
        self,
        relpath: str,
        var: str,
        prefix: str,
        chain: tuple[str, ...],
        mount: str,
        included: set[tuple[str, str]],
    ) -> None:
        """Depth-first mount-graph walk emitting facts with composed prefixes."""
        index = self.indexes[relpath]
        node_key = f"{relpath}:{var}"
        if node_key in chain:
            self.unresolved.append({
                "code": "FASTAPI_PREFIX_UNRESOLVED",
                "detail": (
                    f"include cycle through '{var}' in {relpath}; the effective "
                    "mount graph cannot be proven statically"
                ),
                "location": {"file": relpath, "line": 1, "col": 0},
            })
            return
        router = index.routers.get(var)
        if router is not None:
            if router.alias_of is not None:
                target, resolution = self._module_router_ex(relpath, router.alias_of, router.alias_of[2])
                if target is None:
                    if resolution is not None and resolution.ambiguous is not None:
                        self.unresolved.append({
                            "code": FASTAPI_PREFIX_UNRESOLVED,
                            "detail": (
                                f"router '{var}' in {relpath} is an import alias whose target "
                                f"module matches multiple scanned files under the configured "
                                f"import roots ({', '.join(resolution.ambiguous)}); the target "
                                "router cannot be proven uniquely"
                            ),
                            "location": loc(relpath, router.prefix_node),
                        })
                    else:
                        self.unresolved.append({
                            "code": FASTAPI_PREFIX_UNRESOLVED,
                            "detail": (
                                f"router '{var}' in {relpath} is an import alias whose "
                                "target router cannot be resolved in the scanned set"
                            ),
                            "location": loc(relpath, router.prefix_node),
                        })
                    return
                self._walk(target[0], target[1], prefix, chain + (node_key,), mount, included)
                return
            if router.prefix is None:
                self.unresolved.append({
                    "code": "FASTAPI_PREFIX_UNRESOLVED",
                    "detail": (
                        f"router '{var}' in {relpath} declares a computed prefix; "
                        "the effective path cannot be proven statically"
                    ),
                    "location": loc(relpath, router.prefix_node),
                })
                self._report_computed_paths(relpath, router)
                return
            prefix = prefix + router.prefix
            self._emit_routes(index, router, prefix, mount)
        elif var not in index.apps:
            return
        for edge in index.include_edges:
            if edge.owner_var != var:
                continue
            # Materialized (registry-function) edges resolve and locate at
            # the file the include call is written in, not the instance's.
            edge_home = edge.file or relpath
            target, resolution = self._resolve_target(edge_home, edge)
            if target is None:
                if resolution is not None and resolution.ambiguous is not None:
                    self.unresolved.append({
                        "code": FASTAPI_PREFIX_UNRESOLVED,
                        "detail": (
                            f"include_router target "
                            f"'{edge.target_var or (edge.target_attrs[0] if edge.target_attrs else None)}' "
                            f"in {edge_home} matches multiple scanned files under the configured "
                            f"import roots ({', '.join(resolution.ambiguous)}); the target "
                            "router cannot be proven uniquely"
                        ),
                        "location": loc(edge_home, edge.node),
                    })
                    continue
                self.unresolved.append({
                    "code": FASTAPI_PREFIX_UNRESOLVED,
                    "detail": (
                        f"include_router target "
                        f"'{edge.target_var or (edge.target_attrs[0] if edge.target_attrs else None)}' in {edge_home} "
                        "cannot be resolved in the scanned set"
                    ),
                    "location": loc(edge_home, edge.node),
                })
                continue
            if edge.prefix is None:
                self.unresolved.append({
                    "code": "FASTAPI_PREFIX_UNRESOLVED",
                    "detail": (
                        f"include_router prefix in {edge_home} is computed; "
                        "the effective path cannot be proven statically"
                    ),
                    "location": loc(edge_home, edge.node),
                })
                continue
            self._walk(
                target[0], target[1], prefix + edge.prefix,
                chain + (node_key,), "include-chain", included,
            )

    def _report_computed_paths(self, relpath: str, router: RouterDef) -> None:
        """Reports computed route paths even when the prefix already failed,
        so every unprovable construct carries its own typed entry."""
        for route in router.routes:
            if route.methods and route.path is None:
                self.unresolved.append({
                    "code": "HTTP_PATH_DYNAMIC",
                    "detail": (
                        f"route path for '{route.handler}' in {relpath} is "
                        "computed; the effective path cannot be proven statically"
                    ),
                    "location": loc(relpath, route.node),
                })

    def _emit_routes(self, index: FileIndex, router: RouterDef, prefix: str, mount: str) -> None:
        for route in router.routes:
            if not route.methods:
                if not any(node is route.node for node, _ in index.unsupported):
                    self.unresolved.append({
                        "code": "HTTP_METHOD_DYNAMIC",
                        "detail": (
                            f"route decorator on '{route.handler}' in "
                            f"{index.relpath} declares only computed verbs"
                        ),
                        "location": loc(index.relpath, route.node),
                    })
                continue
            if route.path is None:
                self.unresolved.append({
                    "code": "HTTP_PATH_DYNAMIC",
                    "detail": (
                        f"route path for '{route.handler}' in {route.file} is "
                        "computed; the effective path cannot be proven statically"
                    ),
                    "location": loc(route.file, route.node),
                })
                continue
            for method in route.methods:
                self.facts.append(
                    _fact(route.file, route, method, prefix + route.path, mount)
                )


def _fact(relpath: str, route: RouteDef, method: str, effective_path: str, mount: str) -> dict:
    handler_qname = f"{relpath[:-3].replace('/', '.')}:{route.handler}"
    return {
        "schemaVersion": 1,
        "kind": CONTRACT_KIND,
        "source": relpath,
        "location": loc(relpath, route.node),
        "detectorVersion": VERSION,
        "attributes": {
            "role": "server-route",
            "method": method,
            "rawPath": route.path or "",
            "normalizedPath": "",  # canonicalized by the TS wrapper (single impl)
            "effectivePath": effective_path,
            "framework": FRAMEWORK,
            "handlerSymbol": handler_qname,
            "isAsync": route.is_async,
            "responseModel": route.response_model,
            "requestSchemaSymbols": route.request_schemas,
            "tags": route.tags,
            "operationId": route.operation_id,
            "mountProvenance": mount,
        },
        "id": f"http.contract:{relpath}:{route.handler}:{method}:{effective_path}",
    }


def scan(paths: list[str], root: Path | None = None, import_roots: list[str] | None = None) -> dict:
    """Collect the full deterministic discovery outcome for one request.

    Args:
        paths: Repo-relative files to scan.
        root: Scan root (default: process cwd); every path resolves under it.
        import_roots: Optional repo-root-relative directories that act as
            Python import roots for ABSOLUTE imports (the central-router-
            registry pattern). Each is validated like a scan path; a bad
            root raises (fail closed). Uniqueness of resolution is
            mandatory: an import matching several scanned files across the
            roots is a typed unresolved entry, never a guess.

    Raises:
        OSError: A scanned file is missing/unreadable — surfaced as a
            plugin error frame by the serve loop (fail closed).
    """
    base = root if root is not None else Path.cwd()
    relpaths = [_normalize_path(p) for p in paths]
    roots = tuple(_normalize_path(r) for r in (import_roots or ()))

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

    resolver = _Resolver(indexes, roots)
    resolver.resolve()

    for relpath in sorted(indexes):
        for node, verbs in indexes[relpath].unsupported:
            resolver.unresolved.append({
                "code": "HTTP_METHOD_DYNAMIC",
                "detail": (
                    f"route decorator in {relpath} uses verb(s) {sorted(verbs)} "
                    "outside the supported set"
                ),
                "location": loc(relpath, node),
            })

    resources = resolver.facts
    unresolved = resolver.unresolved

    resources.sort(key=lambda r: r["id"])
    unresolved.sort(
        key=lambda u: (
            u["location"]["file"], u["location"]["line"],
            u["location"]["col"], u["code"], u["detail"],
        )
    )
    findings.sort(
        key=lambda f: (
            f["code"], f["detail"],
            f["locations"][0]["file"] if f["locations"] else "",
            f["locations"][0]["line"] if f["locations"] else 0,
        )
    )
    return {
        "resources": resources,
        "unresolved": unresolved,
        "findings": findings,
        "classificationSignals": [],  # minted by the TS wrapper post-canonicalization
        "scannedPaths": sorted(scanned),
    }
