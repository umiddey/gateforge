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
- ``unresolved`` entries: ``FASTAPI_PREFIX_UNRESOLVED`` for computed
  router/include prefixes, unresolvable include targets/imports/aliases,
  and include cycles; ``HTTP_PATH_DYNAMIC`` for non-literal route paths;
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
    """One ``<owner>.include_router(<target>, prefix=...)`` call."""

    owner_var: str                       # owning router/app var (same file)
    target_var: str | None               # same-file Name target (var or alias)
    target_alias: tuple[str | None, int, str] | None  # Alias.attr target import ref
    target_attr: str | None              # attribute name for alias targets
    prefix: str | None                   # literal include prefix ('' absent; None computed)
    node: ast.AST


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
    """Collects routers, apps, imports, include edges, and route decorators."""

    def __init__(self, relpath: str) -> None:
        self.index = FileIndex(relpath=relpath)

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
        self.generic_visit(node)  # visit_Call records include_router everywhere

    def visit_Call(self, node: ast.Call) -> None:
        self._visit_include_call(node)
        self.generic_visit(node)

    # -- detail walkers -------------------------------------------------------

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
        target_attr: str | None = None
        if isinstance(target, ast.Name):
            target_var = target.id  # same-file var or import alias
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
            ref = self.index.imports.get(target.value.id)
            if ref is not None and ref.name is not None:
                target_alias = (ref.module, ref.level, ref.name)
                target_attr = target.attr
        prefix_node = _keyword(node, "prefix")
        self.index.include_edges.append(
            IncludeEdge(
                owner_var=owner,
                target_var=target_var,
                target_alias=target_alias,
                target_attr=target_attr,
                prefix="" if prefix_node is None else _static_string(prefix_node),
                node=node,
            )
        )


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


def _resolve_import(file_relpath: str, ref: tuple[str | None, int, str], module_map: dict[str, str]) -> str | None:
    """Resolve an import to one scanned module, including source-root aliases.

    Args:
        file_relpath: Repo-relative importing file.
        ref: Parsed import tuple ``(module, relative-level, imported-name)``.
        module_map: Dotted module names available in the scanned set.

    Returns:
        str | None: The unique matching scanned module, or None when the
        import is ambiguous or outside the scanned set.
    """
    raw_module, level, name = ref
    parts = _module_of(file_relpath).split(".")
    if level > 0:
        up = level - 1
        parts = parts[: len(parts) - up] if up > 0 else parts
        if raw_module:
            parts.extend(raw_module.split("."))
        candidate = ".".join(parts)
    else:
        candidate = raw_module or ""

    if candidate in module_map:
        return candidate
    with_name = f"{candidate}.{name}" if name else candidate
    if with_name in module_map:
        return with_name

    # Applications often run with a package directory on PYTHONPATH, so
    # imports such as ``from api.v1.routes`` resolve to ``backend.api.v1.routes``
    # when the repository is scanned from its parent directory. Accept only a
    # unique suffix match; ambiguity remains fail-closed.
    suffix = f".{candidate}" if candidate else ""
    matches = sorted(module for module in module_map if suffix and module.endswith(suffix))
    if len(matches) == 1:
        return matches[0]
    with_name_suffix = f".{with_name}" if with_name else ""
    matches = sorted(module for module in module_map if with_name_suffix and module.endswith(with_name_suffix))
    return matches[0] if len(matches) == 1 else None


class _Resolver:
    """Composes effective mounted paths over the cross-file mount graph."""

    def __init__(self, indexes: dict[str, FileIndex]) -> None:
        self.indexes = indexes
        self.module_map = {_module_of(rel): rel for rel in indexes}
        self.facts: list[dict] = []
        self.unresolved: list[dict] = []

    def resolve(self) -> None:
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
                found = self._resolve_target(relpath, edge)
                if found is not None:
                    targets.add(found)
        return targets

    def _resolve_target(self, relpath: str, edge: IncludeEdge) -> tuple[str, str] | None:
        """(file, router var) an include edge points at, or None."""
        if edge.target_var is not None:
            if edge.target_var in self.indexes[relpath].routers:
                return (relpath, edge.target_var)
            ref = self.indexes[relpath].imports.get(edge.target_var)
            if ref is None:
                return None
            return self._module_router(relpath, (ref.module, ref.level, ref.name), ref.name)
        if edge.target_alias is not None and edge.target_attr is not None:
            module = _resolve_import(relpath, edge.target_alias, self.module_map)
            if module is None:
                return None
            # ``from a import items`` + ``items.router``: try a.items first.
            target_file = self.module_map.get(f"{module}.{edge.target_attr}")
            if (
                target_file is not None
                and "router" in self.indexes[target_file].routers
            ):
                return (target_file, "router")
            target_file = self.module_map.get(module)
            if target_file is not None and edge.target_attr in self.indexes[target_file].routers:
                return (target_file, edge.target_attr)
        return None

    def _module_router(
        self, relpath: str, ref: tuple[str | None, int, str], var: str,
    ) -> tuple[str, str] | None:
        """(file, var) for an imported router name, or None."""
        module = _resolve_import(relpath, ref, self.module_map)
        if module is None:
            return None
        target_file = self.module_map.get(f"{module}.{var}") or self.module_map.get(module)
        if target_file is not None and var in self.indexes[target_file].routers:
            return (target_file, var)
        return None

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
                target = self._module_router(relpath, router.alias_of, router.alias_of[2])
                if target is None:
                    self.unresolved.append({
                        "code": "FASTAPI_PREFIX_UNRESOLVED",
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
            target = self._resolve_target(relpath, edge)
            if target is None:
                self.unresolved.append({
                    "code": "FASTAPI_PREFIX_UNRESOLVED",
                    "detail": (
                        f"include_router target "
                        f"'{edge.target_var or edge.target_attr}' in {relpath} "
                        "cannot be resolved in the scanned set"
                    ),
                    "location": loc(relpath, edge.node),
                })
                continue
            if edge.prefix is None:
                self.unresolved.append({
                    "code": "FASTAPI_PREFIX_UNRESOLVED",
                    "detail": (
                        f"include_router prefix in {relpath} is computed; "
                        "the effective path cannot be proven statically"
                    ),
                    "location": loc(relpath, edge.node),
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


def scan(paths: list[str], root: Path | None = None) -> dict:
    """Collect the full deterministic discovery outcome for one request.

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

    resolver = _Resolver(indexes)
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
