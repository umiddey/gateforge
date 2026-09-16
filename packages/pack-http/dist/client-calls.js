/**
 * Bounded static dataflow for frontend API-client calls (ADR 0004 D6,
 * plan phase 3).
 *
 * Real ASTs (the TypeScript compiler API, pure analysis — no evaluation,
 * no I/O beyond the caller-provided file set) replace the old regex
 * client scan. The model is deliberately bounded:
 *
 * - **Direct literal calls**: `fetch('/x')`, `axios.get('/x')`, instance
 *   verbs, `axios({url, method})` — method from verb name or a literal /
 *   const `method` property; never a silent GET default for computed
 *   methods (those become `HTTP_METHOD_DYNAMIC`).
 * - **Module constants**: `const X = '/x'` / template / builder call,
 *   resolved across the scanned file set through relative imports with a
 *   cycle guard and memoization.
 * - **Templates**: `${expr}` holes resolve through the same value table;
 *   rooted holes become positional `{}` slots without needing runtime
 *   values; an unresolvable hole before the path is rooted (host/base)
 *   makes the whole target `FRONTEND_CALL_TARGET_UNRESOLVED`.
 * - **Configured client symbols** (`apiClient.get(...)`) and **pure URL
 *   builders** (`buildApiPath('/v1/x')` with an optional declared base)
 *   are configuration-declared resolvable APIs — never coverage
 *   exemptions: unresolved flows still block.
 * - **Instance baseURL joining**: when an instance symbol's creation is
 *   modeled — a module-scope `const apiClient = axios.create({...})`
 *   whose config carries a proven LITERAL `baseURL` (a direct property,
 *   or one reaching it through a declared constant config object the
 *   creation is assigned from or spreads, resolved by the same bounded
 *   value table) — the base joins into the emitted call path:
 *   `normalizedPath = normalize(baseURL + callPath)` with exactly one
 *   slash seam. Empty/`/` bases, absolute call URLs, and unprovable
 *   (env-dependent) bases join nothing: the callsite behaves exactly as
 *   it would without the feature, and joining never turns a passing
 *   callsite into a blocker. The raw path stays exactly as written.
 * - **Simple wrapper functions**: a configured wrapper whose declaration
 *   in the scanned set is a single `return <client call>(...)` arrow or
 *   function resolves its internal call with the callsite's first
 *   argument substituted for the wrapper's first parameter (one level,
 *   one parameter — anything deeper is typed unresolved).
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { FRONTEND_CALL_TARGET_UNRESOLVED, HTTP_METHOD_DYNAMIC, HTTP_PATH_DYNAMIC, normalizeHttpPath, } from '@gate-forge/http-contract';
import { pathInScope } from '@gate-forge/core';
export const DEFAULT_CLIENT_SCAN_CONFIG = {};
/**
 * Whether `file` (repo-root-relative posix) is inside the top-level
 * client-call scan roots. Absent roots admit EVERY file — the
 * back-compat contract: without the key, scanning is exactly as before.
 */
export function fileInClientScanRoots(config, file) {
    return config.clientScanRoots === undefined || pathInScope(file, config.clientScanRoots);
}
/**
 * Whether `file` is inside the top-level server-route scan roots.
 * Absent roots admit every file (back-compat, same rule as above).
 */
export function fileInServerScanRoots(config, file) {
    return config.serverScanRoots === undefined || pathInScope(file, config.serverScanRoots);
}
/** Whether one entry's own include/exclude scoping admits `file`. */
function entryInScope(file, entry) {
    // Exclude wins over include: a file named by both is out of scope.
    // Deterministic precedence, documented in the README.
    if (entry.exclude !== undefined && pathInScope(file, entry.exclude))
        return false;
    if (entry.include !== undefined && !pathInScope(file, entry.include))
        return false;
    return true;
}
/** Whether ANY configured client-symbol entry named `name` admits `file`. */
function clientSymbolEntriesAdmit(config, name, file) {
    return (config.clientSymbols?.some((entry) => typeof entry === 'string' ? entry === name : entry.name === name && entryInScope(file, entry)) ?? false);
}
/**
 * Whether a callsite in `file` uses the configured client symbol
 * `name`: the file must match the top-level clientScanRoots (if
 * present) AND the symbol's own include/exclude (if present). Both
 * gates must pass — per-symbol scoping composes with (never relaxes)
 * the top-level roots.
 */
export function clientSymbolActiveIn(config, name, file) {
    if (!fileInClientScanRoots(config, file))
        return false;
    return clientSymbolEntriesAdmit(config, name, file);
}
/** The active configured wrapper named `name` for `file`, if any. */
function activeWrapperIn(config, name, file) {
    if (!fileInClientScanRoots(config, file))
        return undefined;
    return config.wrapperFunctions?.find((entry) => entry.name === name && entryInScope(file, entry));
}
/** The active configured URL builder named `name` for `file`, if any. */
function activeUrlBuilderIn(config, name, file) {
    if (!fileInClientScanRoots(config, file))
        return undefined;
    return config.urlBuilders?.find((entry) => entry.name === name && entryInScope(file, entry));
}
/**
 * True when `name` is declared somewhere in the configuration but NO
 * entry for it admits `file` — the e2e helper that happens to share a
 * configured symbol's name. Such calls are IGNORED, neither resolved
 * nor blocked: the configuration has explicitly spoken about the name
 * and scoped it elsewhere, so interpreting out-of-scope calls (or
 * firing the undeclared-wrapper evidence rule on them) would resurface
 * exactly the harness false positives this scoping removes. Names with
 * no configuration mention never take this path (the evidence rule
 * still blocks undeclared wrappers).
 */
function declaredElsewhere(config, name, file) {
    const mentioned = (config.clientSymbols?.some((entry) => (typeof entry === 'string' ? entry : entry.name) === name) ?? false) ||
        (config.wrapperFunctions?.some((entry) => entry.name === name) ?? false) ||
        (config.urlBuilders?.some((entry) => entry.name === name) ?? false);
    if (!mentioned)
        return false;
    return (!clientSymbolEntriesAdmit(config, name, file) &&
        config.wrapperFunctions?.some((entry) => entry.name === name && entryInScope(file, entry)) !== true &&
        config.urlBuilders?.some((entry) => entry.name === name && entryInScope(file, entry)) !== true);
}
/**
 * The configured client-symbol names ACTIVE for `file` — used by the
 * server-route scanner to disambiguate `api.get('/x')`-shaped client
 * calls from router registrations. Scope-aware: a symbol scoped away
 * from this file does not suppress route discovery in it (out of client
 * scope, `<symbol>.<verb>(path, handler)` can only be a router).
 */
export function activeClientSymbolNamesIn(config, file) {
    const names = new Set();
    for (const entry of config.clientSymbols ?? []) {
        const name = typeof entry === 'string' ? entry : entry.name;
        if (clientSymbolActiveIn(config, name, file))
            names.add(name);
    }
    return [...names].sort();
}
const VERB_METHODS = new Map([
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['patch', 'PATCH'],
    ['delete', 'DELETE'],
    ['head', 'HEAD'],
    ['options', 'OPTIONS'],
]);
const UNRESOLVED_VALUE = { kind: 'unresolved', text: '' };
function languageKindFor(file) {
    if (file.endsWith('.tsx'))
        return ts.ScriptKind.TSX;
    if (file.endsWith('.jsx'))
        return ts.ScriptKind.JSX;
    if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}
function parseSource(sourceText, file) {
    return ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, languageKindFor(file));
}
/** Collects module-scope constants and configured wrapper declarations. */
function modelFile(source, config, file) {
    const constants = new Map();
    const clientFunctions = new Set();
    const wrappers = new Map();
    const isModuleScope = (node) => {
        let current = node.parent;
        while (current !== undefined) {
            if (ts.isFunctionDeclaration(current) ||
                ts.isFunctionExpression(current) ||
                ts.isArrowFunction(current) ||
                ts.isMethodDeclaration(current) ||
                ts.isBlock(current)) {
                return false;
            }
            current = current.parent;
        }
        return true;
    };
    const visit = (node) => {
        if ((ts.isVariableStatement(node)) &&
            isModuleScope(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined)
                    continue;
                constants.set(declaration.name.text, declaration.initializer);
                // One-declaration wrapper: `const apiGet = (path) => fetch(...)`.
                const init = declaration.initializer;
                if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
                    modelWrapper(declaration.name.text, init, wrappers);
                    if (containsClientCall(init, config, file))
                        clientFunctions.add(declaration.name.text);
                }
            }
        }
        if ((ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) ||
            (ts.isVariableStatement(node))) {
            // Named function declarations can be client wrappers too.
            if (ts.isFunctionDeclaration(node) && node.name !== undefined && containsClientCall(node, config, file)) {
                clientFunctions.add(node.name.text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { source, constants, clientFunctions, wrappers };
}
/** True when the subtree contains a direct fetch/axios/client call. */
function containsClientCall(node, config, file) {
    let found = false;
    const visit = (current) => {
        if (found || !ts.isCallExpression(current)) {
            ts.forEachChild(current, visit);
            return;
        }
        const expression = current.expression;
        if (ts.isIdentifier(expression) && expression.text === 'fetch') {
            found = true;
            return;
        }
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
            const objectName = expression.expression.text;
            if (objectName === 'axios' ||
                expression.name.text === 'fetch' ||
                clientSymbolActiveIn(config, objectName, file)) {
                found = true;
                return;
            }
        }
        ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
}
function modelWrapper(name, fn, wrappers) {
    const first = fn.parameters[0];
    if (first === undefined || !ts.isIdentifier(first.name) || fn.parameters.length !== 1)
        return;
    let body;
    if (ts.isArrowFunction(fn)) {
        body = ts.isExpression(fn.body) ? fn.body : undefined;
    }
    else if (fn.body !== undefined && ts.isBlock(fn.body) && fn.body.statements.length === 1) {
        const only = fn.body.statements[0];
        if (only !== undefined && ts.isReturnStatement(only) && only.expression !== undefined) {
            body = only.expression;
        }
    }
    if (body === undefined || !ts.isCallExpression(body))
        return;
    const client = calleeClientName(body);
    if (client !== null) {
        wrappers.set(name, {
            parameter: first.name.text,
            call: body,
            client,
            start: fn.getStart(),
            end: fn.getEnd(),
        });
    }
}
/** `fetch`, `axios`, or a configured client symbol — else null. */
function calleeClientName(call) {
    const expression = call.expression;
    if (ts.isIdentifier(expression))
        return expression.text === 'fetch' ? 'fetch' : expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
        const object = expression.expression;
        if (ts.isIdentifier(object))
            return object.text;
    }
    return null;
}
/**
 * Scans one file for frontend API-client calls under the bounded model.
 * `scannedFiles` maps repo-relative paths to source text for every file
 * in the discovery request (import resolution stays inside the set).
 *
 * Scan scoping (phase 3): a file outside `clientScanRoots` (when the
 * key is present) returns EMPTY — no calls AND no unresolved entries.
 * The gate comes first on purpose: even bare `fetch` extraction must
 * not run, because a scoped-out file (an e2e spec, a test harness) is
 * not product frontend consumption and must be invisible to this
 * channel, blockers included. Files outside the roots still participate
 * in the value table as import targets — scoping narrows fact
 * emission, not the dataflow's ability to resolve product code.
 */
export function scanClientCalls(file, sourceText, config, scannedFiles) {
    if (!fileInClientScanRoots(config, file))
        return { calls: [], unresolved: [] };
    const source = parseSource(sourceText, file);
    const table = new ValueTable(config, scannedFiles);
    const model = table.modelOf(file);
    const calls = [];
    const unresolved = [];
    const wrapperSpans = [...(model?.wrappers.values() ?? [])].map((w) => [w.start, w.end]);
    const insideWrapper = (node) => wrapperSpans.some(([start, end]) => node.getStart(source) >= start && node.getEnd() <= end);
    const visit = (node) => {
        if (ts.isCallExpression(node) && !insideWrapper(node)) {
            extractCall(node, file, config, table, model, calls, unresolved);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    calls.sort(byLocation);
    unresolved.sort((a, b) => (a.location.file < b.location.file ? -1 : a.location.file > b.location.file ? 1 : 0) ||
        a.location.line - b.location.line ||
        a.location.col - b.location.col ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return { calls, unresolved };
}
function byLocation(a, b) {
    return ((a.location.file < b.location.file ? -1 : a.location.file > b.location.file ? 1 : 0) ||
        a.location.line - b.location.line ||
        a.location.col - b.location.col);
}
function locationOf(file, source, node) {
    const start = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    return { file, line: line + 1, col: character };
}
function extractCall(call, file, config, table, model, calls, unresolved) {
    const source = model?.source;
    if (source === undefined)
        return;
    const location = locationOf(file, source, call);
    const expression = call.expression;
    // fetch(url[, {method}])
    if (ts.isIdentifier(expression) && expression.text === 'fetch') {
        extractClientCall(call, 'fetch', 'GET', file, config, table, calls, unresolved, location);
        return;
    }
    // axios.get(url), apiClient.post(url), window.fetch(url)
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
        const objectName = expression.expression.text;
        const verb = expression.name.text.toLowerCase();
        const isFetchObject = objectName === 'window' && expression.name.text === 'fetch';
        if (isFetchObject) {
            extractClientCall(call, 'fetch', 'GET', file, config, table, calls, unresolved, location);
            return;
        }
        // Per-symbol scoping (phase 3): the symbol counts only where its
        // include/exclude (and the top-level roots) admit this file.
        const configured = clientSymbolActiveIn(config, objectName, file);
        if ((objectName === 'axios' || configured) && VERB_METHODS.has(verb)) {
            const method = VERB_METHODS.get(verb) ?? 'GET';
            // Instance baseURL joining: a modeled `axios.create` creation with a
            // proven literal baseURL joins into the emitted path (fetch has no
            // instance and never joins).
            const baseURL = table.instanceBaseURL(objectName, file);
            extractClientCall(call, objectName, method, file, config, table, calls, unresolved, location, baseURL);
            return;
        }
    }
    // axios(url[, config]) / axios.request(config) / instance(config)
    let configCall = null;
    let framework = null;
    if (ts.isIdentifier(expression) && (expression.text === 'axios' || clientSymbolActiveIn(config, expression.text, file))) {
        configCall = call;
        framework = expression.text;
    }
    else if (ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.name.text === 'request' &&
        (expression.expression.text === 'axios' ||
            clientSymbolActiveIn(config, expression.expression.text, file))) {
        configCall = call;
        framework = expression.expression.text;
    }
    if (configCall !== null && framework !== null) {
        const baseURL = table.instanceBaseURL(framework, file);
        extractConfiguredCall(configCall, framework, file, config, table, calls, unresolved, location, baseURL);
        return;
    }
    // Configured wrapper: the declaration must exist in the scanned set as
    // a simple single-return client call; URL comes from the internal call
    // with the callsite's first argument substituted for the parameter,
    // method from configuration. Anything else is typed unresolved — a
    // first-arg-only guess could join the wrong route.
    const wrapperConfig = ts.isIdentifier(expression) ? activeWrapperIn(config, expression.text, file) : undefined;
    if (wrapperConfig !== undefined) {
        const wrapperModel = table.modelOf(file)?.wrappers.get(wrapperConfig.name);
        if (wrapperModel === undefined) {
            unresolved.push({
                code: FRONTEND_CALL_TARGET_UNRESOLVED,
                detail: (`wrapper '${wrapperConfig.name}' has no simple single-return client call in the ` +
                    'scanned set; its call targets cannot be resolved statically'),
                location,
            });
            return;
        }
        const bound = new BoundTable(table, wrapperModel.parameter, call.arguments[0], file);
        const internal = wrapperModel.call;
        const internalExpression = internal.expression;
        let urlNode;
        if (ts.isIdentifier(internalExpression) && internalExpression.text === 'fetch' && internal.arguments.length > 0) {
            urlNode = internal.arguments[0];
        }
        else if (ts.isPropertyAccessExpression(internalExpression) &&
            VERB_METHODS.has(internalExpression.name.text.toLowerCase()) &&
            internal.arguments.length > 0) {
            urlNode = internal.arguments[0];
        }
        if (urlNode === undefined) {
            unresolved.push({
                code: FRONTEND_CALL_TARGET_UNRESOLVED,
                detail: `wrapper '${wrapperConfig.name}' internal call target is outside the supported model`,
                location,
            });
            return;
        }
        resolveAndRecord(urlNode, wrapperConfig.name, wrapperConfig.method, file, config, bound, calls, unresolved, location);
        return;
    }
    // A module-scope function whose body issues client calls IS a client
    // wrapper — evidence from the code itself. Calling it without
    // declaring it in the configuration is a typed block, never silence.
    // EXCEPTION (phase 3 scan-scoping): a name the configuration DOES
    // declare but scopes to other files is the e2e-helper collision —
    // declaredElsewhere ignores it instead of blocking (see there).
    if (ts.isIdentifier(expression) &&
        !declaredElsewhere(config, expression.text, file) &&
        (model?.clientFunctions.has(expression.text) ?? false)) {
        unresolved.push({
            code: FRONTEND_CALL_TARGET_UNRESOLVED,
            detail: (`call to '${expression.text}' resolves to an HTTP client wrapper that is not ` +
                'declared in the client-scan configuration; declare it to make its targets resolvable'),
            location,
        });
    }
}
/**
 * Evaluates expressions with the wrapper's first parameter bound to the
 * callsite argument (one-level bounded dataflow).
 */
class BoundTable {
    inner;
    parameter;
    argument;
    argumentFile;
    constructor(inner, parameter, argument, argumentFile) {
        this.inner = inner;
        this.parameter = parameter;
        this.argument = argument;
        this.argumentFile = argumentFile;
    }
    evaluate(node, file) {
        if (ts.isIdentifier(node) && node.text === this.parameter && this.argument !== undefined) {
            return this.inner.evaluate(this.argument, this.argumentFile);
        }
        if (ts.isTemplateExpression(node)) {
            let text = node.head.text;
            let rooted = text.startsWith('/');
            for (const span of node.templateSpans) {
                const hole = this.evaluate(span.expression, file);
                if (hole.kind === 'unresolved') {
                    if (!rooted)
                        return { kind: 'unresolved', text: '' };
                    text += '${}';
                }
                else {
                    text += hole.text;
                    rooted = rooted || hole.text.startsWith('/');
                }
                text += span.literal.text;
            }
            return { kind: 'literal', text };
        }
        return this.inner.evaluate(node, file);
    }
}
function extractClientCall(call, framework, defaultMethod, file, config, table, calls, unresolved, location, baseURL) {
    const urlNode = call.arguments[0];
    if (urlNode === undefined) {
        unresolved.push({
            code: FRONTEND_CALL_TARGET_UNRESOLVED,
            detail: `${framework} call has no target argument`,
            location,
        });
        return;
    }
    // Method: explicit option first, else the verb default.
    let method = defaultMethod === 'GET' ? 'GET' : defaultMethod;
    const optionsNode = call.arguments[1];
    if (optionsNode !== undefined && ts.isObjectLiteralExpression(optionsNode)) {
        for (const property of optionsNode.properties) {
            const isMethod = (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'method') ||
                (ts.isShorthandPropertyAssignment(property) && property.name.text === 'method');
            if (isMethod) {
                const initializer = ts.isPropertyAssignment(property)
                    ? property.initializer
                    : property.name;
                const resolved = table.evaluate(initializer, file);
                if (resolved.kind === 'literal') {
                    const normalized = normalizeHttpMethodValue(resolved.text);
                    if (normalized === null) {
                        unresolved.push({
                            code: HTTP_METHOD_DYNAMIC,
                            detail: `fetch call method '${resolved.text}' is not a concrete supported verb`,
                            location,
                        });
                        return;
                    }
                    method = normalized;
                }
                else {
                    unresolved.push({
                        code: HTTP_METHOD_DYNAMIC,
                        detail: 'fetch call method is computed and cannot be proven statically',
                        location,
                    });
                    return;
                }
            }
        }
    }
    if (method === null)
        return;
    resolveAndRecord(urlNode, framework, method, file, config, table, calls, unresolved, location, baseURL);
}
function extractConfiguredCall(call, framework, file, config, table, calls, unresolved, location, baseURL) {
    const configNode = call.arguments[0];
    if (configNode === undefined || !ts.isObjectLiteralExpression(configNode)) {
        unresolved.push({
            code: FRONTEND_CALL_TARGET_UNRESOLVED,
            detail: `${framework} call without an inline config object is outside the supported model`,
            location,
        });
        return;
    }
    let method = 'GET';
    let urlNode;
    for (const property of configNode.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name))
            continue;
        if (property.name.text === 'url')
            urlNode = property.initializer;
        if (property.name.text === 'method') {
            const resolved = table.evaluate(property.initializer, file);
            if (resolved.kind !== 'literal') {
                unresolved.push({
                    code: HTTP_METHOD_DYNAMIC,
                    detail: `${framework} call method is computed and cannot be proven statically`,
                    location,
                });
                return;
            }
            const normalized = normalizeHttpMethodValue(resolved.text);
            if (normalized === null) {
                unresolved.push({
                    code: HTTP_METHOD_DYNAMIC,
                    detail: `${framework} call method '${resolved.text}' is not a concrete supported verb`,
                    location,
                });
                return;
            }
            method = normalized;
        }
    }
    if (urlNode === undefined) {
        unresolved.push({
            code: FRONTEND_CALL_TARGET_UNRESOLVED,
            detail: `${framework} call config carries no literal-resolvable url property`,
            location,
        });
        return;
    }
    resolveAndRecord(urlNode, framework, method, file, config, table, calls, unresolved, location, baseURL);
}
/**
 * axios `isAbsoluteURL`: a call URL beginning `<scheme>://` or a
 * protocol-relative `//` is absolute and IGNORES the configured
 * instance baseURL at runtime — the static join must agree.
 */
const ABSOLUTE_CALL_URL_RE = /^([a-z][a-z\d+\-.]*:)?\/\//i;
/**
 * Joins a proven literal instance baseURL onto one call path — the
 * instance-side mirror of the `urlBuilders[].base` join, with axios
 * `combineURLs` seam semantics: trailing base slashes and leading path
 * slashes collapse so exactly one slash separates base and path
 * (normalization then treats the result like any other raw path —
 * identical query/fragment stripping and `${}`/`{}` slotting). Empty
 * and `/` bases add no prefix (byte-identical output), and an absolute
 * call URL keeps its own base, exactly as axios resolves it at runtime.
 * The raw written path is never mutated; the join affects only the
 * canonical/emitted form.
 */
function joinInstanceBaseURL(baseURL, callPath) {
    if (baseURL === undefined || baseURL === '' || baseURL === '/') {
        return { path: callPath, joined: undefined };
    }
    if (ABSOLUTE_CALL_URL_RE.test(callPath)) {
        return { path: callPath, joined: undefined };
    }
    return {
        path: `${baseURL.replace(/\/+$/, '')}/${callPath.replace(/^\/+/, '')}`,
        joined: baseURL,
    };
}
function resolveAndRecord(urlNode, framework, method, file, config, table, calls, unresolved, location, baseURL) {
    const resolved = table.evaluate(urlNode, file);
    if (resolved.kind === 'unresolved') {
        unresolved.push({
            code: FRONTEND_CALL_TARGET_UNRESOLVED,
            detail: `call target cannot be resolved statically (${framework})`,
            location,
        });
        return;
    }
    const joined = joinInstanceBaseURL(baseURL, resolved.text);
    const canonical = normalizeHttpPath(joined.path, { sameOriginHosts: config.sameOriginHosts });
    if (!canonical.ok) {
        unresolved.push({
            code: FRONTEND_CALL_TARGET_UNRESOLVED,
            detail: `call target '${joined.path}': ${canonical.detail}`,
            location,
        });
        return;
    }
    calls.push({
        method,
        rawPath: resolved.text,
        canonicalPath: canonical.canonical,
        ...(joined.joined !== undefined ? { joinedBaseURL: joined.joined } : {}),
        framework,
        location,
    });
}
function normalizeHttpMethodValue(raw) {
    const upper = raw.trim().toUpperCase();
    if (upper === 'GET' || upper === 'HEAD' || upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE' || upper === 'OPTIONS') {
        return upper;
    }
    return null;
}
/**
 * The one modeled instance-creation shape: `axios.create(...)`. Chained
 * or aliased factories (`getInstance().create`, `makeClient()`) are
 * outside the bounded model — fail closed, no base, unchanged emission.
 */
function isAxiosCreateCall(node) {
    return (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'axios' &&
        node.expression.name.text === 'create');
}
const ABSENT_PROOF = { state: 'absent' };
const UNPROVEN_PROOF = { state: 'unproven' };
const PROVEN_EMPTY_PROOF = { state: 'proven', base: '' };
/** Bounded value resolution over the scanned file set. */
class ValueTable {
    config;
    scannedFiles;
    models = new Map();
    evaluating = new Set();
    baseMemo = new Map();
    constructor(config, scannedFiles) {
        this.config = config;
        this.scannedFiles = scannedFiles;
    }
    modelOf(file) {
        const cached = this.models.get(file);
        if (cached !== undefined)
            return cached;
        const text = this.scannedFiles.get(file);
        if (text === undefined)
            return undefined;
        const model = modelFile(parseSource(text, file), this.config, file);
        this.models.set(file, model);
        return model;
    }
    /**
     * Evaluates one expression to literal text (with `${}` slots kept for
     * template holes) or `unresolved`. Rootedness matters only at the call
     * site: a slot mid-path needs no runtime value, an unresolved prefix does.
     */
    evaluate(node, file) {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            return { kind: 'literal', text: node.text };
        }
        if (ts.isTemplateExpression(node)) {
            let text = node.head.text;
            let rooted = text.startsWith('/') || text.startsWith('${');
            for (const span of node.templateSpans) {
                const hole = this.evaluate(span.expression, file);
                if (hole.kind === 'unresolved') {
                    // Before the path is rooted, an unknown hole poisons the target
                    // (host/base unknown). After it, the hole is a positional slot.
                    if (!rooted)
                        return UNRESOLVED_VALUE;
                    text += '${}';
                }
                else {
                    text += hole.text;
                    rooted = rooted || hole.text.startsWith('/');
                }
                text += span.literal.text;
            }
            return { kind: 'literal', text };
        }
        if (ts.isIdentifier(node)) {
            const name = node.text;
            const key = `${file}::${name}`;
            const model = this.modelOf(file);
            const local = model?.constants.get(name);
            if (local !== undefined) {
                if (this.evaluating.has(key))
                    return UNRESOLVED_VALUE; // cycle guard
                this.evaluating.add(key);
                const value = this.evaluate(local, file);
                this.evaluating.delete(key);
                return value;
            }
            // Cross-file: relative import binding resolved inside the scanned set.
            const imported = this.importedFrom(file, name);
            if (imported !== null) {
                if (this.evaluating.has(`${imported}::${name}`))
                    return UNRESOLVED_VALUE;
                this.evaluating.add(`${imported}::${name}`);
                const value = this.evaluateImported(imported, name);
                this.evaluating.delete(`${imported}::${name}`);
                return value;
            }
            return UNRESOLVED_VALUE;
        }
        // URL builder calls: `buildApiPath('/v1/x')` → base + resolved arg.
        // Per-symbol scoping (phase 3): a builder scoped away from `file`
        // does not resolve here — an in-scope enclosing call whose target
        // needs it fails closed (typed unresolved), never silently.
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const callee = node.expression;
            const builder = activeUrlBuilderIn(this.config, callee.text, file);
            if (builder !== undefined) {
                const argument = node.arguments[0];
                if (argument === undefined)
                    return UNRESOLVED_VALUE;
                const inner = this.evaluate(argument, file);
                if (inner.kind === 'unresolved')
                    return UNRESOLVED_VALUE;
                const base = builder.base ?? '';
                const joined = inner.text.startsWith('/') || base === ''
                    ? `${base}${inner.text}`
                    : `${base}/${inner.text}`;
                return { kind: 'literal', text: joined };
            }
        }
        return UNRESOLVED_VALUE;
    }
    /**
     * The proven literal baseURL of the axios instance `symbol` for a
     * callsite in `file`, or `undefined` when no base is proven (the
     * callsite then behaves exactly as without this feature — never a new
     * blocker). Precedence, most specific wins:
     *
     *  1. The symbol's module-scope creation IN the callsite file.
     *  2. The creation in the relative-import module that provides the
     *     binding (the existing bounded import machinery, nothing looser).
     *  3. A UNIQUE declaration of the symbol across the scanned product
     *     set (the configured-symbol channel already treats the name as
     *     global, and real clients are singletons) — alias-imported
     *     creations resolve here. Every same-named creation found must be
     *     a modeled `axios.create` and all proven bases must agree;
     *     disagreement, a second distinct base, or any unprovable
     *     same-named creation vetoes the join (fail closed). The search
     *     never leaves the top-level clientScanRoots (when present) so an
     *     out-of-scope e2e mock instance cannot poison product calls, and
     *     it never applies to the bare `axios` global, whose base is
     *     axiomatically absent unless shadowed in the callsite file itself.
     *
     * An unprovable base at tiers 1–2 is authoritative for that binding —
     * no fallback to the name search.
     */
    instanceBaseURL(symbol, file) {
        const memoKey = `${file}::${symbol}`;
        if (this.baseMemo.has(memoKey))
            return this.baseMemo.get(memoKey);
        let result;
        const own = this.creationBase(symbol, file, new Set([memoKey]));
        if (own.state === 'absent') {
            result = symbol === 'axios' ? undefined : this.uniqueDeclaredBase(symbol);
        }
        else {
            result = own.state === 'proven' ? own.base : undefined;
        }
        this.baseMemo.set(memoKey, result);
        return result;
    }
    /**
     * Resolves the symbol's creation in `file` (local constant first, then
     * a relative-imported binding) and extracts its base. Absent means no
     * modeled creation was found for this binding.
     */
    creationBase(symbol, file, seen) {
        const local = this.modelOf(file)?.constants.get(symbol);
        if (local !== undefined) {
            return this.creationInitializerBase(local, file, seen);
        }
        const imported = this.importedFrom(file, symbol);
        if (imported !== null) {
            const initializer = this.modelOf(imported)?.constants.get(symbol);
            if (initializer !== undefined) {
                return this.creationInitializerBase(initializer, imported, seen);
            }
        }
        return ABSENT_PROOF;
    }
    creationInitializerBase(initializer, file, seen) {
        if (!isAxiosCreateCall(initializer))
            return UNPROVEN_PROOF;
        return this.axiosCreateBase(initializer.arguments[0], file, seen);
    }
    /**
     * The unique same-named creation across the scanned product set, with
     * the agreement rules from {@link instanceBaseURL} tier 3. Files are
     * visited in sorted order; the verdict is a pure function of the set.
     */
    uniqueDeclaredBase(symbol) {
        let unique;
        for (const candidateFile of [...this.scannedFiles.keys()].sort()) {
            if (!fileInClientScanRoots(this.config, candidateFile))
                continue;
            const initializer = this.modelOf(candidateFile)?.constants.get(symbol);
            if (initializer === undefined)
                continue;
            const proof = this.creationInitializerBase(initializer, candidateFile, new Set([`${candidateFile}::${symbol}`]));
            if (proof.state !== 'proven')
                return undefined;
            if (unique === undefined)
                unique = proof.base;
            else if (unique !== proof.base)
                return undefined;
        }
        return unique;
    }
    /** Extracts the baseURL proof from one `axios.create(...)` argument. */
    axiosCreateBase(argument, file, seen) {
        if (argument === undefined)
            return PROVEN_EMPTY_PROOF;
        return this.baseFromConfigExpression(argument, file, seen);
    }
    baseFromConfigExpression(node, file, seen) {
        if (ts.isObjectLiteralExpression(node))
            return this.baseFromConfigObject(node, file, seen);
        if (ts.isIdentifier(node))
            return this.baseFromConstantObject(node.text, file, seen);
        return UNPROVEN_PROOF;
    }
    /**
     * Resolves a config CONSTANT (`axios.create(config)`) through the
     * same local/relative-import machinery as the value table, cycle-
     * guarded via `seen`.
     */
    baseFromConstantObject(name, file, seen) {
        const local = this.resolveConstantInitializer(name, file, seen);
        if (local !== undefined) {
            const [initializer, originFile] = local;
            const key = `${originFile}::${name}`;
            seen.add(key);
            const result = this.baseFromConfigExpression(initializer, originFile, seen);
            seen.delete(key);
            return result;
        }
        return UNPROVEN_PROOF;
    }
    /**
     * One config object literal, honoring JavaScript property semantics:
     * source order, last writer wins — a direct `baseURL` property and a
     * spread of a proven constant config participate equally, so
     * `{...a, baseURL: '/x'}` proves '/x' and `{baseURL: '/x', ...a}`
     * proves only what `a` proves.
     */
    baseFromConfigObject(object, file, seen) {
        let result = PROVEN_EMPTY_PROOF; // no baseURL member: proven baseless
        for (const property of object.properties) {
            if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
                if (!ts.isIdentifier(property.name) || property.name.text !== 'baseURL')
                    continue;
                const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
                const resolved = this.evaluate(initializer, file);
                result = resolved.kind === 'literal' ? { state: 'proven', base: resolved.text } : UNPROVEN_PROOF;
            }
            else if (ts.isSpreadAssignment(property)) {
                const spread = property.expression;
                result = ts.isIdentifier(spread)
                    ? this.baseFromConstantObject(spread.text, file, seen)
                    : UNPROVEN_PROOF;
            }
        }
        return result;
    }
    /** Local constant initializer, else the relative-imported one. */
    resolveConstantInitializer(name, file, seen) {
        const local = this.modelOf(file)?.constants.get(name);
        if (local !== undefined && !seen.has(`${file}::${name}`))
            return [local, file];
        const imported = this.importedFrom(file, name);
        if (imported !== null && !seen.has(`${imported}::${name}`)) {
            const initializer = this.modelOf(imported)?.constants.get(name);
            if (initializer !== undefined)
                return [initializer, imported];
        }
        return undefined;
    }
    /** `import { NAME } from './m'` — resolves NAME's declaring scanned file. */
    importedFrom(file, name) {
        const model = this.modelOf(file);
        if (model === undefined)
            return null;
        let found = null;
        const visit = (node) => {
            if (found !== null)
                return;
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                const specifier = node.moduleSpecifier.text;
                if (specifier.startsWith('./') || specifier.startsWith('../')) {
                    const resolvedFile = this.resolveSpecifier(file, specifier);
                    if (resolvedFile !== null) {
                        const clause = node.importClause;
                        if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
                            for (const element of clause.namedBindings.elements) {
                                const imported = element.propertyName?.text ?? element.name.text;
                                if (imported === name) {
                                    found = resolvedFile;
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(model.source);
        return found;
    }
    evaluateImported(targetFile, name) {
        const model = this.modelOf(targetFile);
        const initializer = model?.constants.get(name);
        if (initializer === undefined)
            return UNRESOLVED_VALUE;
        return this.evaluate(initializer, targetFile);
    }
    resolveSpecifier(fromFile, specifier) {
        const base = posix.dirname(fromFile.split('\\').join('/'));
        const joined = posix.normalize(posix.join(base, specifier));
        const candidates = [
            joined,
            `${joined}.ts`,
            `${joined}.tsx`,
            `${joined}.js`,
            `${joined}.jsx`,
            `${joined}.mjs`,
            `${joined}.cjs`,
            `${joined}/index.ts`,
            `${joined}/index.tsx`,
            `${joined}/index.js`,
        ];
        for (const candidate of candidates) {
            if (this.scannedFiles.has(candidate))
                return candidate;
        }
        return null;
    }
}
/**
 * Validates the include/exclude scoping fields of one object-form
 * entry. New surface, so strict: a present-but-not-array include or
 * exclude is malformed and throws (fail closed — silently ignoring a
 * scoping directive would scan MORE than the configuration asked for,
 * resurfacing the harness false positives scoping exists to remove).
 */
function parseEntryScoping(record, kind, path) {
    const scoping = {};
    for (const key of ['include', 'exclude']) {
        const value = record[key];
        if (value === undefined)
            continue;
        if (!Array.isArray(value)) {
            throw new Error(`invalid http client config: ${kind} '${String(record['name'])}' ${key} must be an array of globs at ${path}`);
        }
        scoping[key] = value.map((glob) => String(glob));
    }
    return scoping;
}
/**
 * Reads a client-scan config document. Returns the default config when
 * the file is absent; malformed documents throw (fail closed — the CLI
 * surfaces the error instead of scanning with partial trust).
 *
 * Accepted shapes (phase 3 scan-scoping): `clientSymbols` entries are a
 * plain string (back-compat, unscoped) or `{ name, include?, exclude? }`;
 * `wrapperFunctions` / `urlBuilders` entries carry the same optional
 * include/exclude next to their existing `method` / `base` fields; the
 * top-level `clientScanRoots` / `serverScanRoots` arrays scope where
 * client-call and server-route scanning apply at all. Consistent with
 * the pre-existing parser posture: unknown keys are ignored, non-array
 * known keys are ignored, but malformed ENTRY values throw (the wrapper
 * verb check predates this; the new scoping fields throw on wrong
 * shapes and missing names because silently dropping a scope widens the
 * scan instead of narrowing it).
 */
export function readClientScanConfigOrNull(path) {
    if (path === null)
        return DEFAULT_CLIENT_SCAN_CONFIG;
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return DEFAULT_CLIENT_SCAN_CONFIG; // absence is normal; malformed is not (below)
    }
    // YAML is intentionally not a dependency here: the document is JSON or
    // JSON-with-comments parsed by the CLI layer. This module accepts only
    // plain JSON objects.
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
        throw new Error(`invalid http client config: expected an object at ${path}`);
    }
    const document = parsed;
    const config = {};
    if (Array.isArray(document['clientScanRoots'])) {
        config.clientScanRoots = document['clientScanRoots'].map((root) => String(root));
    }
    if (Array.isArray(document['serverScanRoots'])) {
        config.serverScanRoots = document['serverScanRoots'].map((root) => String(root));
    }
    if (Array.isArray(document['clientSymbols'])) {
        config.clientSymbols = document['clientSymbols'].map((entry) => {
            // Plain string: the original shape, unscoped — byte-identical.
            if (typeof entry === 'string')
                return entry;
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new Error(`invalid http client config: clientSymbols entries must be a name or a {name, include?, exclude?} object at ${path}`);
            }
            const record = entry;
            if (record['name'] === undefined) {
                throw new Error(`invalid http client config: clientSymbols object entries must carry a name at ${path}`);
            }
            return { name: String(record['name']), ...parseEntryScoping(record, 'clientSymbols', path) };
        });
    }
    if (Array.isArray(document['wrapperFunctions'])) {
        config.wrapperFunctions = document['wrapperFunctions'].map((entry) => {
            const record = entry;
            const method = normalizeHttpMethodValue(String(record['method'] ?? 'GET'));
            if (method === null) {
                throw new Error(`invalid http client config: wrapper method must be a concrete verb at ${path}`);
            }
            return { name: String(record['name']), method, ...parseEntryScoping(record, 'wrapperFunctions', path) };
        });
    }
    if (Array.isArray(document['urlBuilders'])) {
        config.urlBuilders = document['urlBuilders'].map((entry) => {
            if (typeof entry === 'string')
                return { name: entry };
            const record = entry;
            return {
                name: String(record['name']),
                base: record['base'] === undefined ? undefined : String(record['base']),
                ...parseEntryScoping(record, 'urlBuilders', path),
            };
        });
    }
    if (Array.isArray(document['sameOriginHosts'])) {
        config.sameOriginHosts = document['sameOriginHosts'].map((host) => String(host));
    }
    return config;
}
//# sourceMappingURL=client-calls.js.map