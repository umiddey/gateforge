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
 * - **Simple wrapper functions**: a configured wrapper whose declaration
 *   in the scanned set is a single `return <client call>(...)` arrow or
 *   function resolves its internal call with the callsite's first
 *   argument substituted for the wrapper's first parameter (one level,
 *   one parameter — anything deeper is typed unresolved).
 */

import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import {
  FRONTEND_CALL_TARGET_UNRESOLVED,
  HTTP_METHOD_DYNAMIC,
  HTTP_PATH_DYNAMIC,
  normalizeHttpPath,
} from '@gateforge/http-contract';
import type { HttpMethod } from '@gateforge/http-contract';
import type { Location } from '@gateforge/core';

/** Configuration for the client-call scanner (all optional). */
export interface ClientScanConfig {
  /** Instance symbols exposing verb methods, e.g. `['apiClient']`. */
  clientSymbols?: readonly string[];
  /**
   * Wrapper callables: `name` plus the concrete method the wrapper
   * always issues (wrappers with computed methods stay unresolved).
   */
  wrapperFunctions?: ReadonlyArray<{ name: string; method: HttpMethod }>;
  /** Pure URL builders with an optional literal base they prepend. */
  urlBuilders?: ReadonlyArray<{ name: string; base?: string }>;
  /** Absolute-URL hosts treated as same-origin (canonicalized to path). */
  sameOriginHosts?: readonly string[];
}

export const DEFAULT_CLIENT_SCAN_CONFIG: ClientScanConfig = {};

/** One discovered frontend call (one row per source callsite). */
export interface ClientCall {
  method: HttpMethod;
  /** Path exactly as written after constant substitution. */
  rawPath: string;
  /** Canonical positional form of {@link rawPath} (ADR 0004 D2). */
  canonicalPath: string;
  /** Producing client, e.g. `fetch`, `axios`, `apiClient`, `apiGet`. */
  framework: string;
  location: Location;
}

export interface ClientScanUnresolved {
  code: typeof FRONTEND_CALL_TARGET_UNRESOLVED | typeof HTTP_METHOD_DYNAMIC | typeof HTTP_PATH_DYNAMIC;
  detail: string;
  location: Location;
}

export interface ClientScanResult {
  calls: ClientCall[];
  unresolved: ClientScanUnresolved[];
}

const VERB_METHODS: ReadonlyMap<string, HttpMethod> = new Map([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
]);

/** A resolved constant value: rooted literal text with `${}` slots. */
interface ConstValue {
  kind: 'literal' | 'unresolved';
  text: string;
}

const UNRESOLVED_VALUE: ConstValue = { kind: 'unresolved', text: '' };

/** One parsed file's contribution to the bounded dataflow. */
interface FileModel {
  source: ts.SourceFile;
  /** Module-scope constant name → value expression node. */
  constants: Map<string, ts.Expression>;
  /** Module-scope function-likes whose bodies contain a client call. */
  clientFunctions: Set<string>;
  /** Wrapper name → (param name, internal call expression, fn span). */
  wrappers: Map<string, {
    parameter: string;
    call: ts.CallExpression;
    client: string;
    start: number;
    end: number;
  }>;
}

function languageKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function parseSource(sourceText: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, languageKindFor(file));
}

/** Collects module-scope constants and configured wrapper declarations. */
function modelFile(source: ts.SourceFile, config: ClientScanConfig): FileModel {
  const constants = new Map<string, ts.Expression>();
  const clientFunctions = new Set<string>();
  const wrappers = new Map<string, {
    parameter: string;
    call: ts.CallExpression;
    client: string;
    start: number;
    end: number;
  }>();
  const isModuleScope = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isBlock(current)
      ) {
        return false;
      }
      current = current.parent;
    }
    return true;
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableStatement(node)) &&
      isModuleScope(node)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        constants.set(declaration.name.text, declaration.initializer);
        // One-declaration wrapper: `const apiGet = (path) => fetch(...)`.
        const init = declaration.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          modelWrapper(declaration.name.text, init, wrappers);
          if (containsClientCall(init, config)) clientFunctions.add(declaration.name.text);
        }
      }
    }
    if (
      (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) ||
      (ts.isVariableStatement(node))
    ) {
      // Named function declarations can be client wrappers too.
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && containsClientCall(node, config)) {
        clientFunctions.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { source, constants, clientFunctions, wrappers };
}

/** True when the subtree contains a direct fetch/axios/client call. */
function containsClientCall(node: ts.Node, config: ClientScanConfig): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
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
      if (
        objectName === 'axios' ||
        expression.name.text === 'fetch' ||
        (config.clientSymbols?.includes(objectName) ?? false)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function modelWrapper(
  name: string,
  fn: ts.ArrowFunction | ts.FunctionExpression,
  wrappers: Map<string, {
    parameter: string;
    call: ts.CallExpression;
    client: string;
    start: number;
    end: number;
  }>,
): void {
  const first = fn.parameters[0];
  if (first === undefined || !ts.isIdentifier(first.name) || fn.parameters.length !== 1) return;
  let body: ts.Expression | undefined;
  if (ts.isArrowFunction(fn)) {
    body = ts.isExpression(fn.body) ? fn.body : undefined;
  } else if (fn.body !== undefined && ts.isBlock(fn.body) && fn.body.statements.length === 1) {
    const only = fn.body.statements[0];
    if (only !== undefined && ts.isReturnStatement(only) && only.expression !== undefined) {
      body = only.expression;
    }
  }
  if (body === undefined || !ts.isCallExpression(body)) return;
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
function calleeClientName(call: ts.CallExpression): string | null {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text === 'fetch' ? 'fetch' : expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const object = expression.expression;
    if (ts.isIdentifier(object)) return object.text;
  }
  return null;
}

/**
 * Scans one file for frontend API-client calls under the bounded model.
 * `scannedFiles` maps repo-relative paths to source text for every file
 * in the discovery request (import resolution stays inside the set).
 */
export function scanClientCalls(
  file: string,
  sourceText: string,
  config: ClientScanConfig,
  scannedFiles: ReadonlyMap<string, string>,
): ClientScanResult {
  const source = parseSource(sourceText, file);
  const table = new ValueTable(config, scannedFiles);
  const model = table.modelOf(file);
  const calls: ClientCall[] = [];
  const unresolved: ClientScanUnresolved[] = [];
  const wrapperSpans = [...(model?.wrappers.values() ?? [])].map((w) => [w.start, w.end] as const);

  const insideWrapper = (node: ts.Node): boolean =>
    wrapperSpans.some(([start, end]) => node.getStart(source) >= start && node.getEnd() <= end);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !insideWrapper(node)) {
      extractCall(node, file, config, table, model, calls, unresolved);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  calls.sort(byLocation);
  unresolved.sort(
    (a, b) =>
      (a.location.file < b.location.file ? -1 : a.location.file > b.location.file ? 1 : 0) ||
      a.location.line - b.location.line ||
      a.location.col - b.location.col ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  return { calls, unresolved };
}

function byLocation(a: { location: Location }, b: { location: Location }): number {
  return (
    (a.location.file < b.location.file ? -1 : a.location.file > b.location.file ? 1 : 0) ||
    a.location.line - b.location.line ||
    a.location.col - b.location.col
  );
}

function locationOf(file: string, source: ts.SourceFile, node: ts.Node): Location {
  const start = node.getStart(source);
  const { line, character } = source.getLineAndCharacterOfPosition(start);
  return { file, line: line + 1, col: character };
}

function extractCall(
  call: ts.CallExpression,
  file: string,
  config: ClientScanConfig,
  table: ValueTable,
  model: FileModel | undefined,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
): void {
  const source = model?.source;
  if (source === undefined) return;
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
    const configured = config.clientSymbols?.includes(objectName) ?? false;
    if ((objectName === 'axios' || configured) && VERB_METHODS.has(verb)) {
      const method = VERB_METHODS.get(verb) ?? 'GET';
      extractClientCall(call, objectName, method, file, config, table, calls, unresolved, location);
      return;
    }
  }
  // axios(url[, config]) / axios.request(config) / instance(config)
  let configCall: ts.CallExpression | null = null;
  let framework: string | null = null;
  if (ts.isIdentifier(expression) && (expression.text === 'axios' || (config.clientSymbols?.includes(expression.text) ?? false))) {
    configCall = call;
    framework = expression.text;
  } else if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.name.text === 'request' &&
    (expression.expression.text === 'axios' ||
      (config.clientSymbols?.includes(expression.expression.text) ?? false))
  ) {
    configCall = call;
    framework = expression.expression.text;
  }
  if (configCall !== null && framework !== null) {
    extractConfiguredCall(configCall, framework, file, config, table, calls, unresolved, location);
    return;
  }
  // Configured wrapper: the declaration must exist in the scanned set as
  // a simple single-return client call; URL comes from the internal call
  // with the callsite's first argument substituted for the parameter,
  // method from configuration. Anything else is typed unresolved — a
  // first-arg-only guess could join the wrong route.
  if (ts.isIdentifier(expression) && (config.wrapperFunctions?.some((w) => w.name === expression.text) ?? false)) {
    const wrapperConfig = config.wrapperFunctions?.find((w) => w.name === expression.text);
    if (wrapperConfig === undefined) return;
    const wrapperModel = table.modelOf(file)?.wrappers.get(wrapperConfig.name);
    if (wrapperModel === undefined) {
      unresolved.push({
        code: FRONTEND_CALL_TARGET_UNRESOLVED,
        detail: (
          `wrapper '${wrapperConfig.name}' has no simple single-return client call in the ` +
          'scanned set; its call targets cannot be resolved statically'
        ),
        location,
      });
      return;
    }
    const bound = new BoundTable(table, wrapperModel.parameter, call.arguments[0], file);
    const internal = wrapperModel.call;
    const internalExpression = internal.expression;
    let urlNode: ts.Expression | undefined;
    if (ts.isIdentifier(internalExpression) && internalExpression.text === 'fetch' && internal.arguments.length > 0) {
      urlNode = internal.arguments[0];
    } else if (
      ts.isPropertyAccessExpression(internalExpression) &&
      VERB_METHODS.has(internalExpression.name.text.toLowerCase()) &&
      internal.arguments.length > 0
    ) {
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
  if (ts.isIdentifier(expression) && (model?.clientFunctions.has(expression.text) ?? false)) {
    unresolved.push({
      code: FRONTEND_CALL_TARGET_UNRESOLVED,
      detail: (
        `call to '${expression.text}' resolves to an HTTP client wrapper that is not ` +
        'declared in the client-scan configuration; declare it to make its targets resolvable'
      ),
      location,
    });
  }
}

/** Anything that can evaluate an expression under the bounded model. */
interface Evaluator {
  evaluate(node: ts.Expression, file: string): ConstValue;
}

/**
 * Evaluates expressions with the wrapper's first parameter bound to the
 * callsite argument (one-level bounded dataflow).
 */
class BoundTable implements Evaluator {
  constructor(
    private readonly inner: ValueTable,
    private readonly parameter: string,
    private readonly argument: ts.Expression | undefined,
    private readonly argumentFile: string,
  ) {}

  evaluate(node: ts.Expression, file: string): ConstValue {
    if (ts.isIdentifier(node) && node.text === this.parameter && this.argument !== undefined) {
      return this.inner.evaluate(this.argument, this.argumentFile);
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      let rooted = text.startsWith('/');
      for (const span of node.templateSpans) {
        const hole = this.evaluate(span.expression, file);
        if (hole.kind === 'unresolved') {
          if (!rooted) return { kind: 'unresolved', text: '' };
          text += '${}';
        } else {
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

function extractClientCall(
  call: ts.CallExpression,
  framework: string,
  defaultMethod: HttpMethod | 'GET',
  file: string,
  config: ClientScanConfig,
  table: Evaluator,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
): void {
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
  let method: HttpMethod | null = defaultMethod === 'GET' ? 'GET' : defaultMethod;
  const optionsNode = call.arguments[1];
  if (optionsNode !== undefined && ts.isObjectLiteralExpression(optionsNode)) {
    for (const property of optionsNode.properties) {
      const isMethod =
        (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'method') ||
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
        } else {
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
  if (method === null) return;
  resolveAndRecord(urlNode, framework, method, file, config, table, calls, unresolved, location);
}

function extractConfiguredCall(
  call: ts.CallExpression,
  framework: string,
  file: string,
  config: ClientScanConfig,
  table: Evaluator,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
): void {
  const configNode = call.arguments[0];
  if (configNode === undefined || !ts.isObjectLiteralExpression(configNode)) {
    unresolved.push({
      code: FRONTEND_CALL_TARGET_UNRESOLVED,
      detail: `${framework} call without an inline config object is outside the supported model`,
      location,
    });
    return;
  }
  let method: HttpMethod | null = 'GET';
  let urlNode: ts.Expression | undefined;
  for (const property of configNode.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    if (property.name.text === 'url') urlNode = property.initializer;
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
  resolveAndRecord(urlNode, framework, method, file, config, table, calls, unresolved, location);
}

function resolveAndRecord(
  urlNode: ts.Expression,
  framework: string,
  method: HttpMethod,
  file: string,
  config: ClientScanConfig,
  table: Evaluator,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
): void {
  const resolved = table.evaluate(urlNode, file);
  if (resolved.kind === 'unresolved') {
    unresolved.push({
      code: FRONTEND_CALL_TARGET_UNRESOLVED,
      detail: `call target cannot be resolved statically (${framework})`,
      location,
    });
    return;
  }
  const canonical = normalizeHttpPath(resolved.text, { sameOriginHosts: config.sameOriginHosts });
  if (!canonical.ok) {
    unresolved.push({
      code: FRONTEND_CALL_TARGET_UNRESOLVED,
      detail: `call target '${resolved.text}': ${canonical.detail}`,
      location,
    });
    return;
  }
  calls.push({ method, rawPath: resolved.text, canonicalPath: canonical.canonical, framework, location });
}

function normalizeHttpMethodValue(raw: string): HttpMethod | null {
  const upper = raw.trim().toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE' || upper === 'OPTIONS') {
    return upper;
  }
  return null;
}

/** Bounded value resolution over the scanned file set. */
class ValueTable {
  private readonly models = new Map<string, FileModel>();
  private readonly evaluating = new Set<string>();

  constructor(
    private readonly config: ClientScanConfig,
    private readonly scannedFiles: ReadonlyMap<string, string>,
  ) {}

  modelOf(file: string): FileModel | undefined {
    const cached = this.models.get(file);
    if (cached !== undefined) return cached;
    const text = this.scannedFiles.get(file);
    if (text === undefined) return undefined;
    const model = modelFile(parseSource(text, file), this.config);
    this.models.set(file, model);
    return model;
  }

  /**
   * Evaluates one expression to literal text (with `${}` slots kept for
   * template holes) or `unresolved`. Rootedness matters only at the call
   * site: a slot mid-path needs no runtime value, an unresolved prefix does.
   */
  evaluate(node: ts.Expression, file: string): ConstValue {
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
          if (!rooted) return UNRESOLVED_VALUE;
          text += '${}';
        } else {
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
        if (this.evaluating.has(key)) return UNRESOLVED_VALUE; // cycle guard
        this.evaluating.add(key);
        const value = this.evaluate(local, file);
        this.evaluating.delete(key);
        return value;
      }
      // Cross-file: relative import binding resolved inside the scanned set.
      const imported = this.importedFrom(file, name);
      if (imported !== null) {
        if (this.evaluating.has(`${imported}::${name}`)) return UNRESOLVED_VALUE;
        this.evaluating.add(`${imported}::${name}`);
        const value = this.evaluateImported(imported, name);
        this.evaluating.delete(`${imported}::${name}`);
        return value;
      }
      return UNRESOLVED_VALUE;
    }
    // URL builder calls: `buildApiPath('/v1/x')` → base + resolved arg.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression;
      const builder = this.config.urlBuilders?.find((entry) => entry.name === callee.text);
      if (builder !== undefined) {
        const argument = node.arguments[0];
        if (argument === undefined) return UNRESOLVED_VALUE;
        const inner = this.evaluate(argument, file);
        if (inner.kind === 'unresolved') return UNRESOLVED_VALUE;
        const base = builder.base ?? '';
        const joined = inner.text.startsWith('/') || base === ''
          ? `${base}${inner.text}`
          : `${base}/${inner.text}`;
        return { kind: 'literal', text: joined };
      }
    }
    return UNRESOLVED_VALUE;
  }

  /** `import { NAME } from './m'` — resolves NAME's declaring scanned file. */
  importedFrom(file: string, name: string): string | null {
    const model = this.modelOf(file);
    if (model === undefined) return null;
    let found: string | null = null;
    const visit = (node: ts.Node): void => {
      if (found !== null) return;
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

  private evaluateImported(targetFile: string, name: string): ConstValue {
    const model = this.modelOf(targetFile);
    const initializer = model?.constants.get(name);
    if (initializer === undefined) return UNRESOLVED_VALUE;
    return this.evaluate(initializer, targetFile);
  }

  private resolveSpecifier(fromFile: string, specifier: string): string | null {
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
      if (this.scannedFiles.has(candidate)) return candidate;
    }
    return null;
  }
}

/**
 * Reads a client-scan config document. Returns the default config when
 * the file is absent; malformed documents throw (fail closed — the CLI
 * surfaces the error instead of scanning with partial trust).
 */
export function readClientScanConfigOrNull(path: string | null): ClientScanConfig {
  if (path === null) return DEFAULT_CLIENT_SCAN_CONFIG;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return DEFAULT_CLIENT_SCAN_CONFIG; // absence is normal; malformed is not (below)
  }
  // YAML is intentionally not a dependency here: the document is JSON or
  // JSON-with-comments parsed by the CLI layer. This module accepts only
  // plain JSON objects.
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`invalid http client config: expected an object at ${path}`);
  }
  const document = parsed as Record<string, unknown>;
  const config: ClientScanConfig = {};
  if (Array.isArray(document['clientSymbols'])) {
    config.clientSymbols = document['clientSymbols'].map((name) => String(name));
  }
  if (Array.isArray(document['wrapperFunctions'])) {
    config.wrapperFunctions = document['wrapperFunctions'].map((entry) => {
      const record = entry as Record<string, unknown>;
      const method = normalizeHttpMethodValue(String(record['method'] ?? 'GET'));
      if (method === null) {
        throw new Error(`invalid http client config: wrapper method must be a concrete verb at ${path}`);
      }
      return { name: String(record['name']), method };
    });
  }
  if (Array.isArray(document['urlBuilders'])) {
    config.urlBuilders = document['urlBuilders'].map((entry) => {
      if (typeof entry === 'string') return { name: entry };
      const record = entry as Record<string, unknown>;
      return { name: String(record['name']), base: record['base'] === undefined ? undefined : String(record['base']) };
    });
  }
  if (Array.isArray(document['sameOriginHosts'])) {
    config.sameOriginHosts = document['sameOriginHosts'].map((host) => String(host));
  }
  return config;
}
