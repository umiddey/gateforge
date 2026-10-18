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
 *   makes the whole target `FRONTEND_CALL_TARGET_UNRESOLVED`. A trailing
 *   hole that provably closes the path as a query/fragment suffix
 *   (`?…`/`#…`/empty — conditionals, logical forms, const-bound names)
 *   renders as a bare `?` so normalization strips the query instead of
 *   gluing a positional segment.
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
 *   one parameter — anything deeper is typed unresolved). A wrapper may
 *   also name the endpoint parameter (`parameter`) and, when
 *   `methodFromBody` is set, keep each concrete verb in its body. The
 *   declaration may live in another scanned file, including a default
 *   export, and a JSX attribute of that parameter is a callsite.
 * - **Local shapes** (still fail closed): a single-assignment `const`
 *   (a closer `let` stays unresolved), both branches of a conditional,
 *   a `const` object-literal lookup (every literal value), a destructured
 *   relative dynamic-import alias of a configured symbol or builder, and
 *   a same-file function whose returns are a finite resolvable set.
 *   A `const` named `fetch` whose initializer is not the Fetch API is
 *   not a fetch call.
 */

import ts from 'typescript';
import { posix } from 'node:path';
import {
  FRONTEND_CALL_TARGET_UNRESOLVED,
  HTTP_METHOD_DYNAMIC,
  HTTP_PATH_DYNAMIC,
  normalizeHttpPath,
} from '@gate-forge/http-contract';
import type { HttpMethod } from '@gate-forge/http-contract';
import { pathInScope, type Location } from '@gate-forge/core';

/**
 * Optional per-entry file scoping (phase 3 scan-scoping). Globs are
 * repo-root-relative posix (`frontend/src/**`), matched with core's
 * deterministic `pathInScope` machinery — the same wildcards as the
 * classification policy's scan roots.
 */
export interface ClientSymbolScoping {
  /**
   * Files the entry applies to. Absent = every scanned file (the
   * back-compat default); present = at least one glob must match.
   */
  include?: readonly string[];
  /**
   * Files the entry never applies to. Any match wins over `include` —
   * a deterministic precedence (documented in the README).
   */
  exclude?: readonly string[];
}

/** A configured client symbol: plain string (unscoped) or scoped object. */
export interface ClientSymbolConfig extends ClientSymbolScoping {
  /** Instance symbol exposing verb methods, e.g. `apiClient`. */
  name: string;
}

/** A configured wrapper callable: `name` + concrete method + scoping. */
export interface WrapperFunctionConfig extends ClientSymbolScoping {
  name: string;
  /**
   * The concrete method the wrapper always issues, unless
   * {@link methodFromBody} is set. A body verb that disagrees with this
   * method stays unresolved — the configuration must not relabel a POST
   * as GET.
   */
  method: HttpMethod;
  /**
   * The parameter that carries the endpoint path. Absent means the first
   * parameter — the original single-parameter wrapper contract.
   */
  parameter?: string;
  /**
   * When true, each client call in the body keeps its own concrete verb.
   * Required when one wrapper issues more than one verb.
   */
  methodFromBody?: boolean;
}

/** A configured pure URL builder: `name` + optional base + scoping. */
export interface UrlBuilderConfig extends ClientSymbolScoping {
  name: string;
  /** Optional literal base the builder prepends. */
  base?: string;
}

/**
 * Configuration for the client-call scanner (all optional).
 *
 * Scan scoping (phase 3): `clientScanRoots` / `serverScanRoots` narrow
 * WHERE client-call and generic server-route scanning apply at all —
 * two real dogfood failures drove this. A consumer's e2e specs defined
 * a helper also named `api`, and every harness call was scanned as
 * product frontend consumption (20 FRONTEND_CALL_TARGET_UNRESOLVED
 * blockers + phantom consumption); another repo discovered false
 * `http.endpoint` server routes inside `tests/e2e` because test-harness
 * mock servers matched the generic route regex. Test-harness calls are
 * a different contract class, so a file outside the roots produces NO
 * facts of that kind at all. Absent keys scan everything — the
 * byte-identical back-compat contract.
 */
export interface ClientScanConfig {
  /** Instance symbols exposing verb methods, e.g. `['apiClient']`. */
  clientSymbols?: ReadonlyArray<string | ClientSymbolConfig>;
  /**
   * Wrapper callables: `name` plus the concrete method the wrapper
   * always issues (wrappers with computed methods stay unresolved).
   */
  wrapperFunctions?: ReadonlyArray<WrapperFunctionConfig>;
  /** Pure URL builders with an optional literal base they prepend. */
  urlBuilders?: ReadonlyArray<UrlBuilderConfig>;
  /** Absolute-URL hosts treated as same-origin (canonicalized to path). */
  sameOriginHosts?: readonly string[];
  /**
   * Repo-root-relative globs limiting client-call scanning (fetch,
   * axios, configured symbols, wrappers, builders). Files outside
   * produce NO client-call facts and NO unresolved entries.
   */
  clientScanRoots?: readonly string[];
  /**
   * Repo-root-relative globs limiting generic server-route scanning
   * (`scanServerRoutes` / `scanNestControllers`). Files outside produce
   * NO server-route facts — test servers are not product routes.
   */
  serverScanRoots?: readonly string[];
}

export const DEFAULT_CLIENT_SCAN_CONFIG: ClientScanConfig = {};

/**
 * Whether `file` (repo-root-relative posix) is inside the top-level
 * client-call scan roots. Absent roots admit EVERY file — the
 * back-compat contract: without the key, scanning is exactly as before.
 */
export function fileInClientScanRoots(config: ClientScanConfig, file: string): boolean {
  return config.clientScanRoots === undefined || pathInScope(file, config.clientScanRoots);
}

/**
 * Whether `file` is inside the top-level server-route scan roots.
 * Absent roots admit every file (back-compat, same rule as above).
 */
export function fileInServerScanRoots(config: ClientScanConfig, file: string): boolean {
  return config.serverScanRoots === undefined || pathInScope(file, config.serverScanRoots);
}

/** Whether one entry's own include/exclude scoping admits `file`. */
function entryInScope(file: string, entry: ClientSymbolScoping): boolean {
  // Exclude wins over include: a file named by both is out of scope.
  // Deterministic precedence, documented in the README.
  if (entry.exclude !== undefined && pathInScope(file, entry.exclude)) return false;
  if (entry.include !== undefined && !pathInScope(file, entry.include)) return false;
  return true;
}

/** Whether ANY configured client-symbol entry named `name` admits `file`. */
function clientSymbolEntriesAdmit(config: ClientScanConfig, name: string, file: string): boolean {
  return (
    config.clientSymbols?.some((entry) =>
      typeof entry === 'string' ? entry === name : entry.name === name && entryInScope(file, entry),
    ) ?? false
  );
}

/**
 * Whether a callsite in `file` uses the configured client symbol
 * `name`: the file must match the top-level clientScanRoots (if
 * present) AND the symbol's own include/exclude (if present). Both
 * gates must pass — per-symbol scoping composes with (never relaxes)
 * the top-level roots.
 */
export function clientSymbolActiveIn(config: ClientScanConfig, name: string, file: string): boolean {
  if (!fileInClientScanRoots(config, file)) return false;
  return clientSymbolEntriesAdmit(config, name, file);
}

/** The active configured wrapper named `name` for `file`, if any. */
function activeWrapperIn(config: ClientScanConfig, name: string, file: string): WrapperFunctionConfig | undefined {
  if (!fileInClientScanRoots(config, file)) return undefined;
  return config.wrapperFunctions?.find((entry) => entry.name === name && entryInScope(file, entry));
}

/** The active configured URL builder named `name` for `file`, if any. */
function activeUrlBuilderIn(config: ClientScanConfig, name: string, file: string): UrlBuilderConfig | undefined {
  if (!fileInClientScanRoots(config, file)) return undefined;
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
function declaredElsewhere(config: ClientScanConfig, name: string, file: string): boolean {
  const mentioned =
    (config.clientSymbols?.some((entry) => (typeof entry === 'string' ? entry : entry.name) === name) ?? false) ||
    (config.wrapperFunctions?.some((entry) => entry.name === name) ?? false) ||
    (config.urlBuilders?.some((entry) => entry.name === name) ?? false);
  if (!mentioned) return false;
  return (
    !clientSymbolEntriesAdmit(config, name, file) &&
    config.wrapperFunctions?.some((entry) => entry.name === name && entryInScope(file, entry)) !== true &&
    config.urlBuilders?.some((entry) => entry.name === name && entryInScope(file, entry)) !== true
  );
}

/**
 * The configured client-symbol names ACTIVE for `file` — used by the
 * server-route scanner to disambiguate `api.get('/x')`-shaped client
 * calls from router registrations. Scope-aware: a symbol scoped away
 * from this file does not suppress route discovery in it (out of client
 * scope, `<symbol>.<verb>(path, handler)` can only be a router).
 */
export function activeClientSymbolNamesIn(config: ClientScanConfig, file: string): string[] {
  const names = new Set<string>();
  for (const entry of config.clientSymbols ?? []) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (clientSymbolActiveIn(config, name, file)) names.add(name);
  }
  return [...names].sort();
}
/**
 * One field the call site reads off this call's response: the name
 * exactly as the code writes it, and where that read happens. Collected
 * by the same bounded static pass that resolves the call target —
 * `.data.<field>`, `.data['<field>']`, and destructuring of the awaited
 * result or of its payload, inside the enclosing function, same file.
 */
export interface ResponseRead {
  field: string;
  location: Location;
  /**
   * Index of the `||` / `??` fallback chain this operand belongs to, in
   * source order within the call; absent for a read that stands alone.
   * `res.data?.invoice_id || res.data?.invoice?.id` is one decision about
   * ONE result, so its operands are judged together by the response-model
   * check instead of one by one.
   */
  chain?: number;
}


/** One discovered frontend call. One callsite may emit several when it provably reaches several targets. */
export interface ClientCall {
  method: HttpMethod;
  /** Path exactly as written after constant substitution. */
  rawPath: string;
  /** Canonical positional form of {@link rawPath} (ADR 0004 D2). */
  canonicalPath: string;
  /**
   * The proven literal instance `baseURL` that was joined into
   * {@link canonicalPath} (`normalize(baseURL + rawPath)`), present ONLY
   * when a join actually happened. Fact emission canonicalizes the joined
   * path while {@link rawPath} stays as written; without a joined base
   * this is absent and emission is byte-identical to the pre-feature
   * contract.
   */
  joinedBaseURL?: string;
  /** Producing client, e.g. `fetch`, `axios`, `apiClient`, `apiGet`. */
  framework: string;
  location: Location;
  /**
   * Fields this call site reads off the response, in source order.
   * Absent when the code reads none — the attribute is minted only when
   * it says something, so a call with no read stays byte-identical to
   * the pre-feature contract.
   */
  responseReads?: ResponseRead[];
  /**
   * Present only when this callsite emits more than one canonical target.
   * Appended to the fact id so siblings do not collide. Absent on a
   * single-target callsite — that id stays byte-identical.
   */
  idDisambiguator?: string;
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

/**
 * The one payload property this model follows: the axios/kit response
 * envelope whose `data` member carries the decoded body.
 */
const PAYLOAD_PROPERTY = 'data';

/**
 * Members of `Response`, of the collection prototypes and of `Object`
 * itself. A read of one of these is a JavaScript member, never a
 * response-model field, so it is never collected — without this a
 * `res.data.map(...)` on a list endpoint would read as a missing field.
 */
const NEVER_MODEL_FIELDS: Readonly<Record<string, boolean>> = {
  at: true, catch: true, concat: true, constructor: true, entries: true, every: true,
  filter: true, find: true, findIndex: true, flat: true, flatMap: true, finally: true,
  forEach: true, get: true, has: true, headers: true, includes: true, indexOf: true,
  join: true, keys: true, length: true, map: true, message: true, name: true, ok: true,
  prototype: true, push: true, reduce: true, shift: true, slice: true, some: true,
  sort: true, status: true, statusText: true, then: true, toJSON: true, toString: true,
  unshift: true, values: true, valueOf: true,
};

/**
 * Members of the response envelope that decide whether the call
 * SUCCEEDED. A branch that opens on one of them of the call's own result
 * is a guard: the error body a failure branch reads is the framework's,
 * never the success model.
 */
const ENVELOPE_MEMBERS: Readonly<Record<string, boolean>> = {
  ok: true,
  status: true,
  statusText: true,
};

/** The `ok` envelope member; its polarity is the whole verdict. */
const OK_MEMBER = 'ok';

/** The last status a successful call answers with (2xx/3xx). */
const SUCCESS_STATUS = 299;

/** The first status a failing call answers with. */
const FAILURE_STATUS = 400;

/** `||` and `??` are the two ways code writes a fallback chain. */
function chainOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken;
}

/**
 * Which arm of a guard runs on the call SUCCEEDING, on it FAILING, or
 * neither being statically known.
 */
type GuardPolarity = 'success' | 'failure' | 'unknown';

/** The numeric value of a boolean or numeric literal, else null. */
function literalValue(node: ts.Expression): number | null {
  const expression = unwrapExpression(node);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return 0;
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** The names a binding pattern binds, in source order. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element) || element.dotDotDotToken !== undefined) continue;
    names.push(...bindingNames(element.name));
  }
  return names;
}

/** The literal key a binding element or property names, or `''`. */
function propertyNameText(name: ts.PropertyName | undefined): string {
  if (name === undefined) return '';
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return '';
}

/** Strips `await`, parentheses and non-null assertions from an expression. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined) return current;
    if (
      ts.isAwaitExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      parent.kind === ts.SyntaxKind.AsExpression ||
      parent.kind === ts.SyntaxKind.NonNullExpression ||
      parent.kind === ts.SyntaxKind.SatisfiesExpression
    ) {
      current = parent as ts.Expression;
      continue;
    }
    return current;
  }
}

/**
 * The node ITSELF with its own wrapping peeled: parentheses, `as T`,
 * `!`. {@link unwrapExpression} walks the other way (from an inner node
 * out to the wrapper around it), which is what a value-table lookup
 * needs; the concise arrow body `=> ({ ... })` IS that wrapper, so the
 * request-options model has to look through it.
 */
function unwrapOwnExpression(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** One bound name and what it holds: the response envelope or the payload. */
interface ReadHolder {
  name: string;
  /** `true` when the name holds the decoded body itself. */
  payload: boolean;
}

/**
 * The bounded static read of the response fields one detected call is
 * consumed through (plan 2026-09-25 Phase 4b item 5).
 *
 * The model is deliberately small and file-local, and it never guesses:
 *
 * - the call's own awaited result is followed through `await` and
 *   parentheses; `<result>.data` is the payload (axios/kit envelope) and
 *   `<result>` alone is the envelope;
 * - a name bound from either of those (`const r = await call`,
 *   `const { data: d } = await call`, `const d = (await call).data`) is
 *   followed by NAME inside the enclosing function-like (nested
 *   function-likes included, so a `useEffect` callback still counts);
 * - every `holder.<field>`, `holder.data.<field>`, `holder.data['<field>']`
 *   and `holder['<field>']` is a read, and so is each key of an object
 *   destructuring of a holder or of `<holder>.data`;
 * - computed access (`d[key]`), a reassigned (`let`) holder, and a read
 *   of a JavaScript member (`data.map`, `data.length`, …) yield nothing;
 * - a branch that opens on the call's OWN envelope (`if (res.ok)`,
 *   `if (!res.ok)`, `if (res.status >= 400)`, `res.ok ? … : …`) is read
 *   for its POLARITY, and only its FAILURE arm is not collected: the
 *   body a failure branch reads is the error envelope, not the success
 *   model. An undecidable condition (a compound test, a comparison this
 *   pass cannot read) drops BOTH arms. A read AFTER the guard is
 *   collected as usual;
 * - a read that is one operand of a `||` / `??` chain carries the chain's
 *   index, so the response-model check can judge the whole chain at once
 *   instead of flagging a defensive fallback.
 *
 * A read is recorded once per field and location, in source order.
 */
function responseReadsOf(
  file: string,
  call: ts.CallExpression,
  source: ts.SourceFile,
): ResponseRead[] {
  const reads = new Map<string, ResponseRead>();
  const chainRoots: ts.Node[] = [];
  // Reads the BINDING pass already saw (an inline `(await call).data.x`).
  // They are recorded first and replayed once `add` knows the holders,
  // which the binding pass is what discovers.
  const bound: Array<{ field: string; node: ts.Node }> = [];
  let add: (field: string, node: ts.Node) => void = (field, node) => {
    bound.push({ field, node });
  };

  const awaited = unwrapExpression(call);
  const envelopeAccess =
    awaited.parent !== undefined &&
    ts.isPropertyAccessExpression(awaited.parent) &&
    awaited.parent.expression === awaited &&
    awaited.parent.name.text === PAYLOAD_PROPERTY
      ? awaited.parent
      : undefined;
  const payload = envelopeAccess;
  const holders: ReadHolder[] = [];
  bindHolder(awaited, false, holders, add);
  if (payload !== undefined) bindHolder(payload, true, holders, add);

  const responseNames = new Set(holders.filter((h) => !h.payload).map((h) => h.name));
  const payloadNames = new Set(holders.filter((h) => h.payload).map((h) => h.name));
  /** Whether an expression IS the decoded payload of this call. */
  const isPayload = (node: ts.Expression): boolean => {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) return payloadNames.has(expression.text);
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === PAYLOAD_PROPERTY &&
      ts.isIdentifier(expression.expression) &&
      responseNames.has(expression.expression.text)
    );
  };

  let scope: ts.Node = source;
  for (let node: ts.Node | undefined = call; node !== undefined; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      scope = node;
      break;
    }
  }
  // A branch that opens on the call's OWN envelope (`if (!res.ok)`,
  // `if (res.status >= 400)`, `res.ok ? … : …`) is a guard: which side
  // runs is not statically known, and the error body a failure branch
  // reads is the framework's, not the success model. Nothing inside such a
  // branch is a proven read of the success model — see the failure-path
  // note in the module doc.
  const guarded = new Set<ts.Node>();
  const isHolderName = (node: ts.Node): boolean =>
    ts.isIdentifier(node) && responseNames.has(node.text);
  /** The envelope member of this call's own result an expression reads. */
  const envelopeMember = (node: ts.Node): string | null =>
    ts.isPropertyAccessExpression(node) &&
    isHolderName(node.expression) &&
    ENVELOPE_MEMBERS[node.name.text] === true
      ? node.name.text
      : null;
  const mentionsEnvelope = (node: ts.Node): boolean => {
    if (envelopeMember(node) !== null) return true;
    let found = false;
    const inspect = (at: ts.Node): void => {
      if (found) return;
      if (envelopeMember(at) !== null) {
        found = true;
        return;
      }
      ts.forEachChild(at, inspect);
    };
    ts.forEachChild(node, inspect);
    return found;
  };
  /**
   * The polarity of an envelope guard, or null when the condition does not
   * test this call's envelope at all.
   *
   * `if (res.ok)` / `if (res.ok === true)` / `if (res.status >= 400)` /
   * `if (res.status !== 201)` and their negations are decided here, so the
   * SUCCESS arm keeps its reads — the error envelope belongs to the
   * failure arm only. A compound condition, a comparison this cannot
   * read, or a `statusText`/`headers` test is `unknown`: neither arm is a
   * proven read of the success model.
   */
  const guardPolarity = (condition: ts.Expression): GuardPolarity | null => {
    const expression = unwrapExpression(condition);
    if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = guardPolarity(expression.operand);
      if (inner === null || inner === 'unknown') return inner;
      return inner === 'success' ? 'failure' : 'success';
    }
    const bare = envelopeMember(expression);
    if (bare !== null) return bare === OK_MEMBER ? 'success' : 'unknown';
    if (!ts.isBinaryExpression(expression)) {
      return mentionsEnvelope(expression) ? 'unknown' : null;
    }
    const member = envelopeMember(expression.left);
    if (member === null) return mentionsEnvelope(expression) ? 'unknown' : null;
    const expected = literalValue(expression.right);
    if (expected === null) return 'unknown';
    const isOk = member === OK_MEMBER;
    const kind = expression.operatorToken.kind;
    const equality = kind === ts.SyntaxKind.EqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const inequality =
      kind === ts.SyntaxKind.ExclamationEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (isOk) {
      // A boolean compared with a boolean literal: `!==` is the negated
      // equality, so `ok !== true` is the failure arm.
      if (!equality && !inequality) return 'unknown';
      const satisfied = (succeeded: boolean): boolean => {
        const same = (succeeded ? 1 : 0) === expected;
        return inequality ? !same : same;
      };
      if (satisfied(true) && !satisfied(false)) return 'success';
      if (!satisfied(true) && satisfied(false)) return 'failure';
      return 'unknown';
    }
    if (inequality) {
      // `status !== 200` reads as "not the success I expected", which is
      // the failure arm even though a 404 satisfies it too.
      if (expected >= 200 && expected <= SUCCESS_STATUS) return 'failure';
      if (expected >= FAILURE_STATUS) return 'success';
      return 'unknown';
    }
    const succeeded = expected >= 200 && expected <= SUCCESS_STATUS;
    const failed = expected >= FAILURE_STATUS;
    switch (kind) {
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        if (succeeded) return 'success';
        if (failed) return 'failure';
        return 'unknown';
      case ts.SyntaxKind.LessThanToken:
        return SUCCESS_STATUS < expected ? 'success' : FAILURE_STATUS < expected ? 'failure' : 'unknown';
      case ts.SyntaxKind.LessThanEqualsToken:
        return SUCCESS_STATUS <= expected ? 'success' : FAILURE_STATUS <= expected ? 'failure' : 'unknown';
      case ts.SyntaxKind.GreaterThanToken:
        return SUCCESS_STATUS > expected ? 'success' : FAILURE_STATUS > expected ? 'failure' : 'unknown';
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return SUCCESS_STATUS >= expected ? 'success' : FAILURE_STATUS >= expected ? 'failure' : 'unknown';
      default:
        return 'unknown';
    }
  };
  const markGuards = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const polarity = guardPolarity(node.expression);
      if (polarity === 'failure') guarded.add(node.thenStatement);
      else if (polarity === 'success' && node.elseStatement !== undefined) {
        guarded.add(node.elseStatement);
      } else if (polarity === 'unknown') {
        guarded.add(node.thenStatement);
        if (node.elseStatement !== undefined) guarded.add(node.elseStatement);
      }
    }
    if (ts.isConditionalExpression(node)) {
      // A ternary on the envelope is the same guard as an `if`: only its
      // failure arm is the error envelope.
      const polarity = guardPolarity(node.condition);
      if (polarity === 'failure') guarded.add(node.whenTrue);
      else if (polarity === 'success') guarded.add(node.whenFalse);
      else if (polarity === 'unknown') {
        guarded.add(node.whenTrue);
        guarded.add(node.whenFalse);
      }
    }
    ts.forEachChild(node, markGuards);
  };
  markGuards(scope);
  /** Whether a node sits inside one of the guarded branch bodies. */
  const insideGuard = (node: ts.Node): boolean => {
    for (let at: ts.Node | undefined = node; at !== undefined && at !== scope; at = at.parent) {
      if (guarded.has(at)) return true;
    }
    return false;
  };
  /** The outermost `||` / `??` chain an operand belongs to, if any. */
  const chainOf = (node: ts.Node): ts.Node | undefined => {
    for (let at: ts.Node | undefined = node; at !== undefined && at !== scope; at = at.parent) {
      if (ts.isBinaryExpression(at) && chainOperator(at.operatorToken.kind)) return at;
    }
    return undefined;
  };
  add = (field: string, node: ts.Node): void => {
    if (field.length === 0 || NEVER_MODEL_FIELDS[field] === true) return;
    if (insideGuard(node)) return;
    const location = locationOf(file, source, node);
    const key = `${field}@${String(location.line)}:${String(location.col)}`;
    if (reads.has(key)) return;
    const root = chainOf(node);
    if (root === undefined) {
      reads.set(key, { field, location });
      return;
    }
    let index = chainRoots.indexOf(root);
    if (index < 0) {
      chainRoots.push(root);
      index = chainRoots.length - 1;
    }
    reads.set(key, { field, location, chain: index });
  };
  for (const read of bound) add(read.field, read.node);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isPayload(node.expression)) {
      add(node.name.text, node);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      isPayload(node.expression)
    ) {
      add(node.argumentExpression.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name) &&
      isPayload(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const field = bindingKey(element);
        if (field.length > 0) add(field, element);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  const ordered = [...reads.values()].sort((left, right) => {
    const where =
      (left.location.file < right.location.file ? -1 : left.location.file > right.location.file ? 1 : 0) ||
      left.location.line - right.location.line ||
      left.location.col - right.location.col ||
      (left.field < right.field ? -1 : left.field > right.field ? 1 : 0);
    return where;
  });
  // Chain numbers are handed out in discovery order; renumber them by
  // where each chain FIRST appears in source, so the fact is independent
  // of the traversal.
  const firstOf = (index: number): ResponseRead =>
    ordered.find((read) => read.chain === index) as ResponseRead;
  const chains = [...new Set(ordered.map((read) => read.chain))]
    .filter((index): index is number => index !== undefined)
    .sort(
      (left, right) =>
        firstOf(left).location.line - firstOf(right).location.line ||
        firstOf(left).location.col - firstOf(right).location.col,
    );
  const renumbered = new Map(chains.map((index, position) => [index, position]));
  return ordered.map((read) =>
    read.chain === undefined ? read : { ...read, chain: renumbered.get(read.chain) ?? read.chain },
  );

  /** The key a binding element pulls off the object it destructures. */
  function bindingKey(element: ts.BindingElement): string {
    const declared = propertyNameText(element.propertyName);
    if (declared.length > 0) return declared;
    return ts.isIdentifier(element.name) ? element.name.text : '';
  }

  /**
   * Records what the awaited result (or its `.data` payload) binds to:
   * a name to follow, or — for a destructured payload — the field keys
   * that destructuring itself reads. `status`/`headers` and every other
   * envelope member are not response-model fields, so they are ignored.
   */
  function bindHolder(
    node: ts.Expression,
    isPayloadNode: boolean,
    into: ReadHolder[],
    addRead: (field: string, node: ts.Node) => void,
  ): void {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined) return;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      // A `let` holder can be reassigned before the read, so the name no
      // longer provably holds this call's response; a `const` one does.
      const declarationList = parent.parent;
      const isConst =
        ts.isVariableDeclarationList(declarationList) &&
        (ts.getCombinedNodeFlags(declarationList) & ts.NodeFlags.Const) !== 0;
      if (!isConst) return;
      if (ts.isIdentifier(parent.name)) {
        into.push({ name: parent.name.text, payload: isPayloadNode });
        return;
      }
      // An array destructuring pulls ELEMENTS, not named fields, out of a
      // response: there is no field name to compare against a model.
      if (!ts.isObjectBindingPattern(parent.name)) return;
      // `const { data: d } = await call` — the payload is one level in;
      // every other envelope key is not a response-model field.
      if (!isPayloadNode) {
        for (const element of parent.name.elements) {
          if (bindingKey(element) !== PAYLOAD_PROPERTY) continue;
          for (const name of bindingNames(element.name)) into.push({ name, payload: true });
        }
        return;
      }
      for (const element of parent.name.elements) {
        const field = bindingKey(element);
        if (field.length > 0) addRead(field, element);
      }
      return;
    }
    if (ts.isBindingElement(parent) && parent.initializer === node) {
      if (!isPayloadNode) {
        if (bindingKey(parent) === PAYLOAD_PROPERTY && ts.isObjectBindingPattern(parent.name)) {
          for (const name of bindingNames(parent.name)) into.push({ name, payload: true });
        }
        return;
      }
      if (ts.isObjectBindingPattern(parent.name)) {
        // `const { data: { dueDate } } = await call` — the nested keys
        // are the fields the body is read through.
        for (const element of parent.name.elements) {
          const field = bindingKey(element);
          if (field.length > 0) addRead(field, element);
        }
        return;
      }
      const key = bindingKey(parent);
      if (key.length > 0) addRead(key, parent);
      return;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      // `(await call).data.<field>` reads one field of the body inline.
      if (isPayloadNode) addRead(parent.name.text, parent);
    }
  }
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

/**
 * What a request-options expression provably says about the verb.
 *
 * `fetch(url, options)` sends a GET only when the options carry no
 * `method`. Deciding that by "the second argument is not an inline
 * object literal" silently invented a GET for every call whose options
 * are built elsewhere — `fetch(PATH, withDeadline({ method: 'POST' }))`
 * became `GET /path`, a route that does not exist, reported as a
 * frontend call to a missing backend route. The three outcomes below are
 * the only ones this bounded model may answer with:
 *
 * - `proven`   — one concrete verb is provable.
 * - `absent`   — the options provably carry no `method` member, so the
 *   platform default (GET) really is what the call sends.
 * - `unproven` — anything else. The call site becomes a typed
 *   `HTTP_METHOD_DYNAMIC` entry and emits NO call fact.
 */
type OptionsMethod =
  | { kind: 'proven'; method: HttpMethod }
  | { kind: 'absent' }
  | { kind: 'unproven' };

const ABSENT_OPTIONS: OptionsMethod = { kind: 'absent' };
const UNPROVEN_OPTIONS: OptionsMethod = { kind: 'unproven' };

/**
 * Bound hops of the request-options model (an options object, a constant
 * naming one, or a single-return function that forwards its argument), so
 * a chain of wrappers is reported, never followed forever.
 */
const MAX_OPTIONS_HOPS = 4;


/** A resolved constant value: rooted literal text with `${}` slots. */
interface ConstValue {
  kind: 'literal' | 'unresolved';
  text: string;
}

const UNRESOLVED_VALUE: ConstValue = { kind: 'unresolved', text: '' };

/**
 * Binds a prop whose per-usage value cannot be proven (attribute
 * omitted with no literal default, non-literal default, attribute
 * present without a value): every evaluator refuses this node, so a
 * computation that consults it fails closed while one that never reads
 * the prop still resolves.
 */
const UNPROVEN_PROP_VALUE = ts.factory.createVoidExpression(ts.factory.createNumericLiteral('0'));

/** Cap on alternatives one expression may prove. Above this, fail closed — never a partial set. */
const MAX_CALL_TARGETS = 32;

/** Calls of a declared wrapper into another declared wrapper, before fail closed. */
const MAX_WRAPPER_DEPTH = 4;

/** Identifier hops followed when recognising a runtime base-URL host, before fail closed. */
const MAX_BASE_HOPS = 4;

type ExprBinding = ReadonlyMap<string, readonly [ts.Expression, string]>;

/** A statically proven scalar: exactly the literal values a destructuring default may take. */
type ConstScalar = null | undefined | string | number | boolean;

type UrlFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** One parsed file's contribution to the bounded dataflow. */
interface FileModel {
  source: ts.SourceFile;
  /** Module-scope constant name → value expression node. */
  constants: Map<string, ts.Expression>;
  /** Module-scope function-likes whose bodies contain a client call. */
  clientFunctions: Set<string>;
  /**
   * Module-scope function-likes by name (declarations and
   * constant-assigned arrows/expressions). The request-options model
   * reads the ONE returned expression of these; it never runs them.
   */
  functions: Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>;
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

/**
 * True when the subtree reads runtime configuration: an `import.meta.env`
 * or `process.env` access at any depth (optional chains and computed
 * members included). Such a value is a host/port the scan can never
 * prove, which is what the template base-hole model keys on.
 */
function referencesRuntimeEnv(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      // `import.meta` parses as a MetaProperty, not a property chain.
      ((ts.isMetaProperty(node.expression) && node.expression.name.text === 'meta') ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'process'))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Collects module-scope constants and configured wrapper declarations. */
function modelFile(source: ts.SourceFile, config: ClientScanConfig, file: string): FileModel {
  const constants = new Map<string, ts.Expression>();
  const clientFunctions = new Set<string>();
  const wrappers = new Map<string, {
    parameter: string;
    call: ts.CallExpression;
    client: string;
    start: number;
    end: number;
  }>();
  const functions = new Map<
    string,
    ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
  >();
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
          functions.set(declaration.name.text, init);
          modelWrapper(declaration.name.text, init, wrappers);
          if (containsClientCall(init, config, file)) clientFunctions.add(declaration.name.text);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      // Named function declarations can be client wrappers too, and the
      // request-options model reads their single returned expression.
      if (isModuleScope(node)) functions.set(node.name.text, node);
      if (node.body !== undefined && containsClientCall(node, config, file)) {
        clientFunctions.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { source, constants, clientFunctions, functions, wrappers };
}

/** True when the subtree contains a direct fetch/axios/client call. */
function containsClientCall(node: ts.Node, config: ClientScanConfig, file: string): boolean {
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
      clientSymbolActiveIn(config, objectName, file)
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
export function scanClientCalls(
  file: string,
  sourceText: string,
  config: ClientScanConfig,
  scannedFiles: ReadonlyMap<string, string>,
): ClientScanResult {
  if (!fileInClientScanRoots(config, file)) return { calls: [], unresolved: [] };
  const source = parseSource(sourceText, file);
  const table = new ValueTable(config, scannedFiles);
  const model = table.modelOf(file);
  const calls: ClientCall[] = [];
  const unresolved: ClientScanUnresolved[] = [];
  const wrapperSpans = modeledWrapperSpans(model, config, file);

  const insideWrapper = (node: ts.Node): boolean =>
    wrapperSpans.some(([start, end]) => node.getStart(source) >= start && node.getEnd() <= end);

  // `client(...error.config...)` calls inside a registered response-error
  // handler re-send a request this scan has already recorded; they are
  // replays, never new call targets. The set fills when the walk reaches
  // the `.use(...)` registration — an ancestor of the handler body — so
  // every replay call is known before its node is reached.
  const replayCalls = new Set<ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (!insideWrapper(node)) {
      if (ts.isCallExpression(node)) {
        collectInterceptorReplays(node, file, config, replayCalls);
        if (!replayCalls.has(node)) {
          extractCall(node, file, config, table, model, calls, unresolved);
        }
      } else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        extractJsxWrapper(node, file, config, table, calls, unresolved);
      }
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
  // The response fields THIS call site reads (plan 2026-09-25 Phase 4b
  // item 5) — the same bounded, file-local pass, attached to whichever
  // call shape below is recognized.
  const reads = responseReadsOf(file, call, source);
  const expression = call.expression;

  // fetch(url[, {method}])
  if (ts.isIdentifier(expression) && expression.text === 'fetch') {
    if (!table.shadowsGlobalFetch(expression)) {
      extractClientCall(call, 'fetch', 'GET', false, file, config, table, calls, unresolved, location, undefined, reads);
    }
    return;
  }
  // axios.get(url), apiClient.post(url), window.fetch(url)
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const objectName = table.configuredClientName(expression.expression, file);
    const verb = expression.name.text.toLowerCase();
    const isFetchObject = objectName === 'window' && expression.name.text === 'fetch';
    if (isFetchObject) {
      extractClientCall(call, 'fetch', 'GET', false, file, config, table, calls, unresolved, location, undefined, reads);
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
      extractClientCall(call, objectName, method, true, file, config, table, calls, unresolved, location, baseURL, reads);
      return;
    }
  }
  // axios(url[, config]) / axios.request(config) / instance(config)
  let configCall: ts.CallExpression | null = null;
  let framework: string | null = null;
  if (ts.isIdentifier(expression) && (expression.text === 'axios' || clientSymbolActiveIn(config, expression.text, file))) {
    configCall = call;
    framework = expression.text;
  } else if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.name.text === 'request' &&
    (expression.expression.text === 'axios' ||
      clientSymbolActiveIn(config, expression.expression.text, file))
  ) {
    configCall = call;
    framework = expression.expression.text;
  }
  if (configCall !== null && framework !== null) {
    const baseURL = table.instanceBaseURL(framework, file);
    extractConfiguredCall(configCall, framework, file, config, table, calls, unresolved, location, baseURL, reads);
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
      if (resolvesToDeclaredWrapper(table, wrapperConfig.name, file, config)) {
        const bindings = new Map<string, readonly [ts.Expression, string]>();
        const declared = table.findFunction(wrapperConfig.name, file);
        const paramName = wrapperConfig.parameter ?? (declared === undefined ? undefined : firstIdentifierParam(declared.fn));
        // Every remaining identifier parameter binds positionally, so the
        // request-options model can prove a verb the body forwards
        // (`fetch(url, { ...options })`); an absent argument binds nothing.
        if (declared !== undefined) {
          declared.fn.parameters.forEach((parameter, index) => {
            if (index === 0 && paramName !== undefined) return;
            if (!ts.isIdentifier(parameter.name)) return;
            const positional = call.arguments[index];
            if (positional !== undefined) bindings.set(parameter.name.text, [positional, file]);
          });
        }
        const takesObjectPattern = declared !== undefined
          && declared.fn.parameters[0] !== undefined
          && ts.isObjectBindingPattern(declared.fn.parameters[0].name);
        if (declared !== undefined && (paramName !== undefined || takesObjectPattern)) {
          const argument = paramName !== undefined
            ? argumentForParameter(declared.fn, paramName, call)
            : call.arguments[0];
          if (argument !== undefined) {
            if (paramName !== undefined) bindings.set(paramName, [argument, file]);
            const sandboxCalls: ClientCall[] = [];
            const sandboxUnresolved: ClientScanUnresolved[] = [];
            const sandboxReads: ResponseRead[] = [];
            const singleHandled = resolveWrapperTargetThroughJsxProps(
              argument,
              call,
              paramName ?? '',
              wrapperConfig,
              file,
              config,
              table,
              bindings,
              sandboxCalls,
              sandboxUnresolved,
              location,
              sandboxReads,
            );
            const positionalCalls: ClientCall[] = [];
            const positionalUnresolved: ClientScanUnresolved[] = [];
            const positionalReads: ResponseRead[] = [];
            const positionalHandled = resolveWrapperTargetsThroughPositionalArgs(
              call,
              declared,
              wrapperConfig,
              file,
              config,
              table,
              positionalCalls,
              positionalUnresolved,
              location,
              positionalReads,
            );
            if (positionalHandled && positionalUnresolved.length === 0) {
              calls.push(...positionalCalls);
              unresolved.push(...positionalUnresolved);
              reads.push(...positionalReads);
              return;
            }
            if (singleHandled) {
              calls.push(...sandboxCalls);
              unresolved.push(...sandboxUnresolved);
              reads.push(...sandboxReads);
              return;
            }
            if (positionalHandled) {
              calls.push(...positionalCalls);
              unresolved.push(...positionalUnresolved);
              reads.push(...positionalReads);
              return;
            }
          }
        }
        resolveExtendedWrapper(wrapperConfig, file, config, table, bindings, calls, unresolved, location, reads);
      }
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
    resolveAndRecord(urlNode, wrapperConfig.name, wrapperConfig.method, file, config, bound, calls, unresolved, location, reads);
    return;
  }
  // A module-scope function whose body issues client calls IS a client
  // wrapper — evidence from the code itself. Calling it without
  // declaring it in the configuration is a typed block, never silence.
  // EXCEPTION (phase 3 scan-scoping): a name the configuration DOES
  // declare but scopes to other files is the e2e-helper collision —
  // declaredElsewhere ignores it instead of blocking (see there).
  if (
    ts.isIdentifier(expression) &&
    !declaredElsewhere(config, expression.text, file) &&
    (model?.clientFunctions.has(expression.text) ?? false)
  ) {
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

/**
 * Anything that can evaluate an expression under the bounded model.
 *
 * `optionsMethod` answers the same question for a REQUEST-OPTIONS
 * expression: an inline object, a constant naming one, or a
 * single-return function that forwards its argument. It is part of the
 * contract because the verb of `fetch(url, options)` may only come from
 * a proven options model — never from "the options were not inline".
 */
interface Evaluator {
  evaluate(node: ts.Expression, file: string): ConstValue;
  callTargets(node: ts.Expression, file: string, bindings?: ExprBinding): readonly string[] | undefined;
  optionsMethod(
    node: ts.Expression,
    file: string,
    bindings?: ExprBinding,
    depth?: number,
  ): OptionsMethod;
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
          // The wrapper's parameter stands for the callsite argument:
          // a suffix is judged by the argument's shape, never the name.
          const fromParameter =
            ts.isIdentifier(span.expression) &&
            span.expression.text === this.parameter &&
            this.argument !== undefined;
          const suffix = fromParameter
            ? this.inner.trailingQuerySuffix(node, span, this.argument, this.argumentFile)
            : this.inner.trailingQuerySuffix(node, span, span.expression, file);
          text += suffix ? '?' : '${}';
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

  callTargets(node: ts.Expression, file: string, bindings?: ExprBinding): readonly string[] | undefined {
    const next = new Map(bindings);
    if (this.argument !== undefined) next.set(this.parameter, [this.argument, this.argumentFile]);
    return this.inner.callTargets(node, file, next);
  }

  optionsMethod(
    node: ts.Expression,
    file: string,
    bindings?: ExprBinding,
    depth = 0,
  ): OptionsMethod {
    if (
      ts.isIdentifier(node) &&
      node.text === this.parameter &&
      this.argument !== undefined
    ) {
      return this.inner.optionsMethod(this.argument, this.argumentFile, bindings, depth + 1);
    }
    return this.inner.optionsMethod(node, file, bindings, depth);
  }
}

function extractClientCall(
  call: ts.CallExpression,
  framework: string,
  defaultMethod: HttpMethod | 'GET',
  /**
   * True when the call's verb comes from a verb-named member
   * (`.get/.post/.put/.patch/.delete/...` on axios or a configured
   * client symbol): the member name IS the method and `arguments[1]` is
   * the request BODY — a spread there says nothing about the verb and is
   * never read as request options.
   */
  methodFromVerb: boolean,
  file: string,
  config: ClientScanConfig,
  table: Evaluator,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
  baseURL?: string | undefined,
  reads: ResponseRead[] = [],
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
  // Method: explicit option first, else the verb default — except for a
  // verb-named call, where the member name decides and arguments[1] is
  // the request body, never request options.
  let method: HttpMethod | null = defaultMethod === 'GET' ? 'GET' : defaultMethod;
  const optionsNode = call.arguments[1];
  if (methodFromVerb) {
    // `apiClient.patch(url, { polygon_json, ...extra })`: the spread is
    // the body's shape, not an options override — the verb stays the
    // member's verb and is never un-proven by what the body spreads.
  } else if (optionsNode !== undefined && ts.isObjectLiteralExpression(optionsNode)) {
    if (optionsNode.properties.some(ts.isSpreadAssignment)) {
      // `{...base, method: ...}`: the verb participates in JavaScript's
      // last-writer-wins order across the spread, so a wrapper's options
      // parameter spread into the literal carries the CALL SITE's verb.
      // The bounded options model answers for the whole literal — a verb
      // it cannot prove stays unresolved and is never assumed to be GET.
      const resolved = table.optionsMethod(optionsNode, file);
      if (resolved.kind === 'unproven') {
        unresolved.push({
          code: HTTP_METHOD_DYNAMIC,
          detail:
            'call request options spread another options object whose method ' +
            'cannot be proven statically; the verb is never assumed to be GET',
          location,
        });
        return;
      }
      if (resolved.kind === 'proven') method = resolved.method;
    } else {
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
  }
  if (
    !methodFromVerb &&
    framework === 'fetch' &&
    optionsNode !== undefined &&
    !ts.isObjectLiteralExpression(optionsNode)
  ) {
    // `fetch(url, options)` with options built elsewhere: the verb is
    // whatever that object carries, and until the bounded options model
    // proves it, assuming GET invents a route the server never serves.
    const resolved = table.optionsMethod(optionsNode, file);
    if (resolved.kind === 'unproven') {
      unresolved.push({
        code: HTTP_METHOD_DYNAMIC,
        detail:
          'fetch call passes request options that are not a provable object literal ' +
          '(they are built by another function or a computed expression); the method ' +
          'cannot be proven statically and is never assumed to be GET',
        location,
      });
      return;
    }
    if (resolved.kind === 'proven') method = resolved.method;
  }
  if (method === null) return;
  resolveAndRecord(urlNode, framework, method, file, config, table, calls, unresolved, location, reads, baseURL);
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
  baseURL?: string | undefined,
  reads: ResponseRead[] = [],
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
  resolveAndRecord(urlNode, framework, method, file, config, table, calls, unresolved, location, reads, baseURL);
}

/**
 * axios `isAbsoluteURL`: a call URL beginning `<scheme>://` or a
 * protocol-relative `//` is absolute and IGNORES the configured
 * instance baseURL at runtime — the static join must agree.
 */
const ABSOLUTE_CALL_URL_RE = /^([a-z][a-z\d+\-.]*:)?\/\//i;

/** Outcome of applying a proven instance baseURL to one call path. */
interface BaseJoin {
  /** The path normalization runs on (joined when a join happened). */
  path: string;
  /** The base actually joined; absent when nothing was joined. */
  joined: string | undefined;
}

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
function joinInstanceBaseURL(baseURL: string | undefined, callPath: string): BaseJoin {
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
  reads: ResponseRead[] = [],
  baseURL?: string,
): void {
  const targets = table.callTargets(urlNode, file);
  if (targets === undefined || targets.length === 0) {
    unresolved.push({
      code: FRONTEND_CALL_TARGET_UNRESOLVED,
      detail: `call target cannot be resolved statically (${framework})`,
      location,
    });
    return;
  }
  recordRawTargets(targets, method, framework, config, calls, unresolved, location, reads, baseURL);
}

function recordRawTargets(
  raws: readonly string[],
  method: HttpMethod,
  framework: string,
  config: ClientScanConfig,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
  reads: ResponseRead[],
  baseURL?: string,
): void {
  const resolved: { raw: string; canonical: string; joined: string | undefined }[] = [];
  for (const raw of raws) {
    const joined = joinInstanceBaseURL(baseURL, raw);
    const canonical = normalizeHttpPath(joined.path, { sameOriginHosts: config.sameOriginHosts });
    if (!canonical.ok) {
      unresolved.push({
        code: FRONTEND_CALL_TARGET_UNRESOLVED,
        detail: `call target '${joined.path}': ${canonical.detail}`,
        location,
      });
      return;
    }
    resolved.push({ raw, canonical: canonical.canonical, joined: joined.joined });
  }
  const unique = new Map<string, { raw: string; joined: string | undefined }>();
  for (const item of resolved) {
    if (!unique.has(item.canonical)) unique.set(item.canonical, { raw: item.raw, joined: item.joined });
  }
  const many = unique.size > 1;
  const ordered = [...unique.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  for (const [canonical, item] of ordered) {
    calls.push({
      method,
      rawPath: item.raw,
      canonicalPath: canonical,
      ...(item.joined !== undefined ? { joinedBaseURL: item.joined } : {}),
      framework,
      location,
      ...(many ? { idDisambiguator: canonical } : {}),
      ...(reads.length > 0 ? { responseReads: reads } : {}),
    });
  }
}

/**
 * The ONE expression a function-like returns, or undefined when it
 * returns none or branches: two return paths can set the verb
 * differently, and an unprovable options object must not be guessed.
 */
function returnedExpression(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined {
  // A concise arrow body IS its returned expression: `(o) => ({ ...o })`.
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return fn.body;
  const body: ts.Block | undefined = ts.isArrowFunction(fn)
    ? ts.isBlock(fn.body)
      ? fn.body
      : undefined
    : fn.body;
  if (body === undefined) return undefined;
  const returns = body.statements.filter((statement): statement is ts.ReturnStatement =>
    ts.isReturnStatement(statement),
  );
  return returns.length === 1 ? returns[0]?.expression : undefined;
}

function normalizeHttpMethodValue(raw: string): HttpMethod | null {
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
function isAxiosCreateCall(node: ts.Expression): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'axios' &&
    node.expression.name.text === 'create'
  );
}

/**
 * baseURL proof for one creation: `absent` (no modeled creation for the
 * binding), `unproven` (a creation exists but its base is not a proven
 * literal — env-dependent, computed, or an unmodeled factory), or
 * `proven` with the literal base text (empty string when the creation
 * provably carries no baseURL).
 */
type BaseProof = { state: 'absent' } | { state: 'unproven' } | { state: 'proven'; base: string };

const ABSENT_PROOF: BaseProof = { state: 'absent' };
const UNPROVEN_PROOF: BaseProof = { state: 'unproven' };
const PROVEN_EMPTY_PROOF: BaseProof = { state: 'proven', base: '' };

/** Bounded value resolution over the scanned file set. */
class ValueTable {
  private readonly models = new Map<string, FileModel>();
  private readonly evaluating = new Set<string>();
  private readonly baseMemo = new Map<string, string | undefined>();

  constructor(
    private readonly config: ClientScanConfig,
    readonly scannedFiles: ReadonlyMap<string, string>,
  ) {}

  modelOf(file: string): FileModel | undefined {
    const cached = this.models.get(file);
    if (cached !== undefined) return cached;
    const text = this.scannedFiles.get(file);
    if (text === undefined) return undefined;
    const model = modelFile(parseSource(text, file), this.config, file);
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
          // (host/base unknown). After it, the hole is a positional slot —
          // unless it provably closes the path as a query/fragment suffix,
          // which renders as `?` so normalization strips the query instead
          // of gluing a positional segment.
          if (!rooted) return UNRESOLVED_VALUE;
          text += this.trailingQuerySuffix(node, span, span.expression, file) ? '?' : '${}';
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
    // Per-symbol scoping (phase 3): a builder scoped away from `file`
    // does not resolve here — an in-scope enclosing call whose target
    // needs it fails closed (typed unresolved), never silently.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression;
      const builder = activeUrlBuilderIn(this.config, callee.text, file);
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

  /**
   * True when one unresolved template hole is a QUERY SUFFIX: the span
   * is the template's LAST element (no trailing literal), and the
   * hole's expression is provably a finite set of literal alternatives
   * that are each the empty string or start with `?`/`#` — a
   * conditional of string/template literals, a logical `c && A` /
   * `A || B` over the same, or an identifier bound by const
   * (function-local nearest binding, else the module machinery) to such
   * an expression. Nested holes are allowed inside a `?`/`#`-headed
   * branch: the rendered `?` collapses them, and normalization strips
   * the query. Everything else — a branch starting with `/`, a
   * mid-template hole, a trailing literal after the hole, an
   * unresolvable name — stays a positional `${}` slot, exactly as
   * before (fail closed, never guessed from names).
   */
  trailingQuerySuffix(
    template: ts.TemplateExpression,
    span: ts.TemplateSpan,
    expression: ts.Expression,
    file: string,
  ): boolean {
    const spans = template.templateSpans;
    if (spans[spans.length - 1] !== span || span.literal.text !== '') return false;
    const alternatives = this.querySuffixAlternatives(expression, file, new Set<string>());
    if (alternatives === undefined) return false;
    return alternatives.every(
      (alternative) => alternative === '' || alternative.startsWith('?') || alternative.startsWith('#'),
    );
  }

  /**
   * The literal alternatives one expression provably takes when it is
   * query-suffix-shaped, or undefined when the bounded model cannot
   * prove the shape.
   */
  private querySuffixAlternatives(
    node: ts.Expression,
    file: string,
    seen: Set<string>,
  ): string[] | undefined {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    // A `?`/`#`-headed template stays suffix-shaped whatever its nested
    // holes hold; a hole-headed one could become any path value.
    if (ts.isTemplateExpression(node)) {
      return node.head.text.startsWith('?') || node.head.text.startsWith('#')
        ? [node.head.text]
        : undefined;
    }
    if (ts.isParenthesizedExpression(node)) {
      return this.querySuffixAlternatives(node.expression, file, seen);
    }
    if (ts.isConditionalExpression(node)) {
      const whenTrue = this.querySuffixAlternatives(node.whenTrue, file, seen);
      if (whenTrue === undefined) return undefined;
      const whenFalse = this.querySuffixAlternatives(node.whenFalse, file, seen);
      return whenFalse === undefined ? undefined : [...whenTrue, ...whenFalse];
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        // `c && A`: a falsey condition contributes the empty suffix.
        const right = this.querySuffixAlternatives(node.right, file, seen);
        return right === undefined ? undefined : ['', ...right];
      }
      if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        const left = this.querySuffixAlternatives(node.left, file, seen);
        if (left === undefined) return undefined;
        const right = this.querySuffixAlternatives(node.right, file, seen);
        return right === undefined ? undefined : [...left, ...right];
      }
      return undefined;
    }
    if (ts.isIdentifier(node)) {
      // A file-local binding shadows any imported/module one; only a
      // `const` with an initializer proves the shape.
      const local = this.localConstBinding(node);
      if (local.state === 'found') {
        const key = `${file}::${node.text}`;
        if (seen.has(key)) return undefined; // cycle guard
        seen.add(key);
        const alternatives = this.querySuffixAlternatives(local.initializer, file, seen);
        seen.delete(key);
        return alternatives;
      }
      if (local.state === 'shadowed') return undefined;
      const constant = this.resolveConstantInitializer(node.text, file, seen);
      if (constant !== undefined) {
        const [initializer, originFile] = constant;
        const key = `${originFile}::${node.text}`;
        if (seen.has(key)) return undefined; // cycle guard
        seen.add(key);
        const alternatives = this.querySuffixAlternatives(initializer, originFile, seen);
        seen.delete(key);
        return alternatives;
      }
      return undefined;
    }
    return undefined;
  }

  /**
   * The nearest visible binding of `use`'s name: declared textually
   * before it in the nearest enclosing function-like scopes, walking
   * outward until a level names the identifier. Only `const` with an
   * initializer counts; any closer `let`/`var`/initializer-less binding
   * shadows fail-closed. Function-likes that do not enclose `use` are
   * invisible from a level.
   */
  private localConstBinding(
    use: ts.Identifier,
  ): { state: 'found'; initializer: ts.Expression } | { state: 'shadowed' } | { state: 'absent' } {
    let scope: ts.Node | undefined = use.parent;
    while (scope !== undefined) {
      if (ts.isFunctionLike(scope) || ts.isSourceFile(scope)) {
        const declaration = this.nearestDeclarationBefore(use, scope);
        if (declaration !== undefined) {
          return (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
            declaration.initializer !== undefined
            ? { state: 'found', initializer: declaration.initializer }
            : { state: 'shadowed' };
        }
      }
      scope = scope.parent;
    }
    return { state: 'absent' };
  }

  /** Nearest same-named declaration textually before `use` in `scope`. */
  private nearestDeclarationBefore(use: ts.Identifier, scope: ts.Node): ts.VariableDeclaration | undefined {
    let best: ts.VariableDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (node !== scope && ts.isFunctionLike(node)) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === use.text &&
        node.name.getEnd() <= use.getStart()
      ) {
        if (best === undefined || node.name.getStart() > best.name.getStart()) best = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return best;
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
  instanceBaseURL(symbol: string, file: string): string | undefined {
    const memoKey = `${file}::${symbol}`;
    if (this.baseMemo.has(memoKey)) return this.baseMemo.get(memoKey);
    let result: string | undefined;
    const own = this.creationBase(symbol, file, new Set([memoKey]));
    if (own.state === 'absent') {
      result = symbol === 'axios' ? undefined : this.uniqueDeclaredBase(symbol);
    } else {
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
  private creationBase(symbol: string, file: string, seen: Set<string>): BaseProof {
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

  private creationInitializerBase(initializer: ts.Expression, file: string, seen: Set<string>): BaseProof {
    if (!isAxiosCreateCall(initializer)) return UNPROVEN_PROOF;
    return this.axiosCreateBase(initializer.arguments[0], file, seen);
  }

  /**
   * The unique same-named creation across the scanned product set, with
   * the agreement rules from {@link instanceBaseURL} tier 3. Files are
   * visited in sorted order; the verdict is a pure function of the set.
   */
  private uniqueDeclaredBase(symbol: string): string | undefined {
    let unique: string | undefined;
    for (const candidateFile of [...this.scannedFiles.keys()].sort()) {
      if (!fileInClientScanRoots(this.config, candidateFile)) continue;
      const initializer = this.modelOf(candidateFile)?.constants.get(symbol);
      if (initializer === undefined) continue;
      const proof = this.creationInitializerBase(initializer, candidateFile, new Set([`${candidateFile}::${symbol}`]));
      if (proof.state !== 'proven') return undefined;
      if (unique === undefined) unique = proof.base;
      else if (unique !== proof.base) return undefined;
    }
    return unique;
  }

  /** Extracts the baseURL proof from one `axios.create(...)` argument. */
  private axiosCreateBase(argument: ts.Expression | undefined, file: string, seen: Set<string>): BaseProof {
    if (argument === undefined) return PROVEN_EMPTY_PROOF;
    return this.baseFromConfigExpression(argument, file, seen);
  }

  private baseFromConfigExpression(node: ts.Expression, file: string, seen: Set<string>): BaseProof {
    if (ts.isObjectLiteralExpression(node)) return this.baseFromConfigObject(node, file, seen);
    if (ts.isIdentifier(node)) return this.baseFromConstantObject(node.text, file, seen);
    return UNPROVEN_PROOF;
  }

  /**
   * Resolves a config CONSTANT (`axios.create(config)`) through the
   * same local/relative-import machinery as the value table, cycle-
   * guarded via `seen`.
   */
  private baseFromConstantObject(name: string, file: string, seen: Set<string>): BaseProof {
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
  private baseFromConfigObject(object: ts.ObjectLiteralExpression, file: string, seen: Set<string>): BaseProof {
    let result: BaseProof = PROVEN_EMPTY_PROOF; // no baseURL member: proven baseless
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        if (!ts.isIdentifier(property.name) || property.name.text !== 'baseURL') continue;
        const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
        const resolved = this.evaluate(initializer, file);
        result = resolved.kind === 'literal' ? { state: 'proven', base: resolved.text } : UNPROVEN_PROOF;
      } else if (ts.isSpreadAssignment(property)) {
        const spread = property.expression;
        result = ts.isIdentifier(spread)
          ? this.baseFromConstantObject(spread.text, file, seen)
          : UNPROVEN_PROOF;
      }
    }
    return result;
  }

  /** Local constant initializer, else the relative-imported one. */
  private resolveConstantInitializer(
    name: string,
    file: string,
    seen: Set<string>,
  ): [ts.Expression, string] | undefined {
    const local = this.modelOf(file)?.constants.get(name);
    if (local !== undefined && !seen.has(`${file}::${name}`)) return [local, file];
    const imported = this.importedFrom(file, name);
    if (imported !== null && !seen.has(`${imported}::${name}`)) {
      const initializer = this.modelOf(imported)?.constants.get(name);
      if (initializer !== undefined) return [initializer, imported];
    }
    return undefined;
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

  /**
   * The verb one request-options expression provably carries.
   *
   * Bounded and deterministic, three shapes only:
   *  - an inline object literal: `method` is read with JavaScript's
   *    last-writer-wins order, and a spread of another resolvable options
   *    expression participates equally (`{...base, method:'POST'}`);
   *  - a name: a module-scope constant in the scanned set (same file or
   *    relative import), followed at most {@link MAX_OPTIONS_HOPS} hops;
   *  - a call to a plain-named function whose declaration is in the
   *    scanned set and whose body is a SINGLE `return <expression>`:
   *    the first parameter binds to this call's first argument, so a
   *    forwarder (`(options) => ({ ...options })`) resolves to whatever
   *    its argument proves.
   * Everything else — a computed member, an attribute, a member call, a
   * function this scan cannot see — is `unproven`, and the caller turns
   * that into a typed `HTTP_METHOD_DYNAMIC` entry instead of a GET.
   */
  optionsMethod(
    node: ts.Expression,
    file: string,
    bindings: ExprBinding = new Map(),
    depth = 0,
  ): OptionsMethod {
    if (depth > MAX_OPTIONS_HOPS) return UNPROVEN_OPTIONS;
    const expression = unwrapOwnExpression(node);
    if (ts.isObjectLiteralExpression(expression)) {
      return this.optionsMethodOfObject(expression, file, bindings, depth);
    }
    if (ts.isIdentifier(expression)) {
      const bound = bindings.get(expression.text);
      if (bound !== undefined) return this.optionsMethod(bound[0], bound[1], bindings, depth + 1);
      const constant = this.resolveConstantInitializer(expression.text, file, new Set());
      if (constant === undefined) return UNPROVEN_OPTIONS;
      return this.optionsMethod(constant[0], constant[1], bindings, depth + 1);
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      return this.optionsMethodThroughCall(expression, file, bindings, depth);
    }
    return UNPROVEN_OPTIONS;
  }

  /** The verb one options object literal carries, spreads included. */
  private optionsMethodOfObject(
    object: ts.ObjectLiteralExpression,
    file: string,
    bindings: ExprBinding,
    depth: number,
  ): OptionsMethod {
    let result: OptionsMethod = ABSENT_OPTIONS;
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = this.optionsMethod(property.expression, file, bindings, depth + 1);
        // JavaScript overwrite order: the LAST writer of `method` wins.
        // An unproven spread may overwrite the verb with an unknown value
        // (stays unproven unless re-proven), a proven spread writes its
        // verb, and a spread provably free of `method` adds nothing, so
        // any earlier or later explicit method survives it.
        if (spread.kind !== 'absent') result = spread;
      } else if (
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'method'
      ) {
        const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
        result = this.verbOfLiteral(initializer, file, bindings);
      }
    }
    return result;
  }

  /** A `method:` member whose value provably is one concrete verb. */
  private verbOfLiteral(
    node: ts.Expression,
    file: string,
    bindings: ExprBinding,
  ): OptionsMethod {
    const bound = ts.isIdentifier(node) ? bindings.get(node.text) : undefined;
    const resolved =
      bound === undefined ? this.evaluate(node, file) : this.evaluate(bound[0], bound[1]);
    if (resolved.kind !== 'literal') return UNPROVEN_OPTIONS;
    const verb = normalizeHttpMethodValue(resolved.text);
    return verb === null ? UNPROVEN_OPTIONS : { kind: 'proven', method: verb };
  }

  /** Options returned by a single-return function declared in the scan. */
  private optionsMethodThroughCall(
    call: ts.CallExpression,
    file: string,
    bindings: ExprBinding,
    depth: number,
  ): OptionsMethod {
    const name = ts.isIdentifier(call.expression) ? call.expression.text : '';
    if (name.length === 0) return UNPROVEN_OPTIONS;
    const declared = this.functionOf(name, file);
    if (declared === undefined) return UNPROVEN_OPTIONS;
    const returned = returnedExpression(declared);
    if (returned === undefined) return UNPROVEN_OPTIONS;
    const next = new Map(bindings);
    const parameter = declared.parameters[0];
    const argument = call.arguments[0];
    if (
      parameter !== undefined &&
      argument !== undefined &&
      ts.isIdentifier(parameter.name)
    ) {
      next.set(parameter.name.text, [argument, file]);
    }
    return this.optionsMethod(returned, file, next, depth + 1);
  }

  /** A module-scope function declaration, same file or relative import. */
  private functionOf(
    name: string,
    file: string,
  ): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
    const own = this.modelOf(file)?.functions.get(name);
    if (own !== undefined) return own;
    const imported = this.importedFrom(file, name);
    if (imported === null) return undefined;
    return this.modelOf(imported)?.functions.get(name);
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

  /**
   * Every literal path `node` can take, or undefined when any branch
   * cannot be proven. A resolved target is exactly a value the code can
   * call — never a guess, never a partial set.
   */
  callTargets(
    node: ts.Expression,
    file: string,
    bindings?: ExprBinding,
    seen: Set<string> = new Set(),
  ): readonly string[] | undefined {
    const peeled = unwrapOwnExpression(node);
    if (peeled !== node) return this.callTargets(peeled, file, bindings, seen);
    if (ts.isSatisfiesExpression(node)) return this.callTargets(node.expression, file, bindings, seen);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return this.expandTemplate(node, file, bindings, seen);
    if (ts.isConditionalExpression(node)) return this.conditionalTargets(node, file, bindings, seen);
    if (ts.isIdentifier(node)) return this.identifierTargets(node, file, bindings, seen);
    if (ts.isElementAccessExpression(node)) return this.lookupTargets(node, file, bindings, seen);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const alias = this.dynamicImportAlias(node.expression, file);
      const builderName = alias?.kind === 'builder' ? alias.name : node.expression.text;
      const builder = alias?.kind === 'client' ? undefined : activeUrlBuilderIn(this.config, builderName, file);
      if (builder !== undefined) {
        const argument = node.arguments[0];
        if (argument === undefined) return undefined;
        const inner = this.callTargets(argument, file, bindings, seen);
        if (inner === undefined) return undefined;
        const base = builder.base ?? '';
        return inner.map((text) => (text.startsWith('/') || base === '' ? `${base}${text}` : `${base}/${text}`));
      }
      if (alias === undefined) return this.finiteFunctionTargets(node, file, bindings, seen);
    }
    return undefined;
  }

  /** A const binding named `fetch` whose initializer is not the Fetch API. */
  shadowsGlobalFetch(use: ts.Identifier): boolean {
    const local = this.localConstBinding(use);
    if (local.state !== 'found') return false;
    const init = unwrapOwnExpression(local.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return true;
    if (!ts.isCallExpression(init)) return false;
    const callee = init.expression;
    if (ts.isIdentifier(callee) && callee.text === 'fetch') return false;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch') return false;
    return true;
  }

  /** Configured client-symbol name for a callsite object, following a dynamic-import alias. */
  configuredClientName(use: ts.Identifier, file: string): string {
    const alias = this.dynamicImportAlias(use, file);
    return alias?.kind === 'client' ? alias.name : use.text;
  }

  /** A function named `name` visible from `file`: same file, or a relative import including default. */
  findFunction(name: string, file: string): { fn: UrlFunction; file: string } | undefined {
    const own = this.modelOf(file)?.functions.get(name);
    if (own !== undefined) return { fn: own, file };
    const imported = this.importedExport(file, name);
    if (imported === null) return undefined;
    const model = this.modelOf(imported.file);
    if (model === undefined) return undefined;
    const fn = imported.exported === 'default' ? defaultExportedFunction(model) : model.functions.get(imported.exported);
    return fn === undefined ? undefined : { fn, file: imported.file };
  }

  private identifierTargets(
    node: ts.Identifier,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): readonly string[] | undefined {
    const bound = bindings?.get(node.text);
    if (bound !== undefined) {
      const rest = new Map(bindings);
      rest.delete(node.text);
      return this.callTargets(bound[0], bound[1], rest, seen);
    }
    const local = this.localConstBinding(node);
    if (local.state === 'shadowed') return undefined;
    if (local.state === 'found') {
      const key = `${file}::${node.text}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      const value = this.callTargets(local.initializer, file, bindings, seen);
      seen.delete(key);
      return value;
    }
    const imported = this.importedFrom(file, node.text);
    const origin = imported ?? file;
    const initializer = this.modelOf(origin)?.constants.get(node.text);
    if (initializer === undefined) return undefined;
    const key = `${origin}::${node.text}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const value = this.callTargets(initializer, origin, bindings, seen);
    seen.delete(key);
    return value;
  }

  private conditionalTargets(
    node: ts.ConditionalExpression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): readonly string[] | undefined {
    const proven = this.proveEquality(node.condition, file, bindings, seen)
      ?? this.proveStartsWith(node.condition, file, bindings, seen);
    if (proven === true) return this.callTargets(node.whenTrue, file, bindings, seen);
    if (proven === false) return this.callTargets(node.whenFalse, file, bindings, seen);
    const joined = this.pathJoinTargets(node, file, bindings, seen);
    if (joined !== undefined) return joined;
    const whenTrue = this.callTargets(node.whenTrue, file, bindings, seen);
    const whenFalse = this.callTargets(node.whenFalse, file, bindings, seen);
    if (whenTrue === undefined || whenFalse === undefined) return undefined;
    const combined = [...whenTrue, ...whenFalse];
    return combined.length > MAX_CALL_TARGETS ? undefined : combined;
  }

  /**
   * The path-join idiom: ``x.endsWith('/') ? `${x}<rest>` : `${x}/<rest>` `` —
   * the test and both arms name the SAME `x`, and the arms differ only by
   * the one joining slash. Both arms build the same URL, so the
   * conditional proves exactly ONE target: the joined template
   * `${x}/<rest>` (the false arm; the true arm is its slash-less twin,
   * and rendering both emitted the ghost shape with the hole glued onto
   * the base). Every other conditional returns undefined here and keeps
   * the both-arms union.
   */
  private pathJoinTargets(
    node: ts.ConditionalExpression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): readonly string[] | undefined {
    const condition = unwrapOwnExpression(node.condition);
    if (
      !ts.isCallExpression(condition) ||
      !ts.isPropertyAccessExpression(condition.expression) ||
      condition.expression.name.text !== 'endsWith' ||
      condition.arguments.length !== 1
    ) {
      return undefined;
    }
    const probe = condition.arguments[0];
    if (
      probe === undefined ||
      !(ts.isStringLiteral(probe) || ts.isNoSubstitutionTemplateLiteral(probe)) ||
      probe.text !== '/'
    ) {
      return undefined;
    }
    const receiver = unwrapOwnExpression(condition.expression.expression);
    if (!this.singleSlashJoinArms(node.whenTrue, node.whenFalse, receiver)) return undefined;
    return this.callTargets(node.whenFalse, file, bindings, seen);
  }

  /** True when the two arms are `${x}<rest>` and `${x}/<rest>` for the same `x`. */
  private singleSlashJoinArms(
    whenTrue: ts.Expression,
    whenFalse: ts.Expression,
    receiver: ts.Expression,
  ): boolean {
    const trueArm = unwrapOwnExpression(whenTrue);
    const falseArm = unwrapOwnExpression(whenFalse);
    if (!ts.isTemplateExpression(trueArm) || !ts.isTemplateExpression(falseArm)) return false;
    if (trueArm.head.text !== '' || falseArm.head.text !== '') return false;
    const trueSpans = trueArm.templateSpans;
    const falseSpans = falseArm.templateSpans;
    if (trueSpans.length === 0 || trueSpans.length !== falseSpans.length) return false;
    const trueHead = trueSpans[0];
    const falseHead = falseSpans[0];
    if (trueHead === undefined || falseHead === undefined) return false;
    if (
      unwrapOwnExpression(trueHead.expression).getText() !== receiver.getText() ||
      unwrapOwnExpression(falseHead.expression).getText() !== receiver.getText()
    ) {
      return false;
    }
    if (falseHead.literal.text !== `/${trueHead.literal.text}`) return false;
    for (let index = 1; index < trueSpans.length; index += 1) {
      const trueSpan = trueSpans[index];
      const falseSpan = falseSpans[index];
      if (trueSpan === undefined || falseSpan === undefined) return false;
      if (trueSpan.literal.text !== falseSpan.literal.text) return false;
      if (unwrapOwnExpression(trueSpan.expression).getText() !== unwrapOwnExpression(falseSpan.expression).getText()) {
        return false;
      }
    }
    return true;
  }

  /** `expr.startsWith('literal')` when `expr` is exactly one literal. Otherwise unproven. */
  private proveStartsWith(
    node: ts.Expression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): boolean | undefined {
    const expr = unwrapOwnExpression(node);
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = this.proveStartsWith(expr.operand, file, bindings, seen);
      return inner === undefined ? undefined : !inner;
    }
    if (
      !ts.isCallExpression(expr) ||
      !ts.isPropertyAccessExpression(expr.expression) ||
      expr.expression.name.text !== 'startsWith' ||
      expr.arguments.length !== 1
    ) {
      return undefined;
    }
    const probe = expr.arguments[0];
    if (probe === undefined || !ts.isStringLiteral(probe)) return undefined;
    const receiver = this.callTargets(expr.expression.expression, file, bindings, seen);
    if (receiver === undefined || receiver.length !== 1) return undefined;
    return (receiver[0] ?? '').startsWith(probe.text);
  }

  /**
   * Proves an `===`/`==`/`!==`/`!=` condition whose two sides are
   * proven scalars — the guard a component writes around a defaulted
   * prop (`detail === null`). Loose equality is only decided when one
   * side is null or undefined: those comparisons never coerce, while
   * `0 == false` would. Undefined when either side is unproven — the
   * caller then keeps both arms.
   */
  private proveEquality(
    node: ts.Expression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): boolean | undefined {
    const expr = unwrapOwnExpression(node);
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = this.proveEquality(expr.operand, file, bindings, seen);
      return inner === undefined ? undefined : !inner;
    }
    if (!ts.isBinaryExpression(expr)) return undefined;
    const op = expr.operatorToken.kind;
    const strict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!strict && !loose) return undefined;
    const left = this.provenScalar(expr.left, file, bindings, seen);
    if (left === 'unknown') return undefined;
    const right = this.provenScalar(expr.right, file, bindings, seen);
    if (right === 'unknown') return undefined;
    if (loose && !(left === null || left === undefined) && !(right === null || right === undefined)) return undefined;
    const equal = strict
      ? left === right
      : left === right || ((left === null || left === undefined) && (right === null || right === undefined));
    return (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)
      ? !equal
      : equal;
  }

  /**
   * The proven scalar of an expression — null, undefined, string,
   * number, boolean — or 'unknown' when the bounded model cannot prove
   * it. Per-usage prop bindings take precedence, mirroring
   * identifierTargets: inside the component the destructured prop
   * shadows any outer constant. Module constants resolve through the
   * same local/import precedence, so a named `NO_ENDPOINT` sentinel
   * proves like its literal.
   */
  private provenScalar(
    node: ts.Expression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): ConstScalar | 'unknown' {
    const expr = unwrapOwnExpression(node);
    if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return Number(expr.text);
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
      return -Number(expr.operand.text);
    }
    if (!ts.isIdentifier(expr)) return 'unknown';
    if (expr.text === 'undefined') {
      return this.localConstBinding(expr).state === 'found' ? 'unknown' : undefined;
    }
    const bound = bindings?.get(expr.text);
    if (bound !== undefined) {
      const key = `${bound[1]}::${expr.text}`;
      if (seen.has(key)) return 'unknown';
      seen.add(key);
      const value = this.provenScalar(bound[0], bound[1], bindings, seen);
      seen.delete(key);
      return value;
    }
    const local = this.localConstBinding(expr);
    if (local.state === 'shadowed') return 'unknown';
    if (local.state === 'found') {
      const key = `${file}::${expr.text}`;
      if (seen.has(key)) return 'unknown';
      seen.add(key);
      const value = this.provenScalar(local.initializer, file, bindings, seen);
      seen.delete(key);
      return value;
    }
    const imported = this.importedFrom(file, expr.text);
    const origin = imported ?? file;
    const initializer = this.modelOf(origin)?.constants.get(expr.text);
    if (initializer === undefined) return 'unknown';
    const key = `${origin}::${expr.text}`;
    if (seen.has(key)) return 'unknown';
    seen.add(key);
    const value = this.provenScalar(initializer, origin, bindings, seen);
    seen.delete(key);
    return value;
  }

  private expandTemplate(
    node: ts.TemplateExpression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): readonly string[] | undefined {
    let pieces: { text: string; rooted: boolean }[] = [{
      text: node.head.text,
      rooted: node.head.text.startsWith('/') || node.head.text.startsWith('${'),
    }];
    for (const span of node.templateSpans) {
      const next: { text: string; rooted: boolean }[] = [];
      const substituted = this.pathHoleTargets(span.expression, file, bindings, seen);
      if (substituted !== undefined) {
        for (const piece of pieces) {
          for (const hole of substituted) {
            next.push({
              text: piece.text + hole + span.literal.text,
              rooted: piece.rooted || hole.startsWith('/'),
            });
          }
        }
      } else {
        const bound = ts.isIdentifier(span.expression) ? bindings?.get(span.expression.text) : undefined;
        const holeExpr = bound?.[0] ?? span.expression;
        const holeFile = bound?.[1] ?? file;
        const hole = bound === undefined ? this.evaluate(span.expression, file) : this.evaluate(holeExpr, holeFile);
        if (hole.kind === 'unresolved') {
          if (
            span.literal.text.startsWith('/') &&
            pieces.every((piece) => !piece.rooted) &&
            this.isRuntimeBaseHole(span.expression, file, bindings)
          ) {
            // The hole is a runtime base URL (env/config host): the
            // request's addressable path starts at the static literal
            // that follows it, so the host is dropped, not invented.
            for (const piece of pieces) {
              next.push({ text: piece.text + span.literal.text, rooted: true });
            }
          } else {
            if (pieces.some((piece) => !piece.rooted)) return undefined;
            const suffix = this.trailingQuerySuffix(node, span, holeExpr, holeFile);
            const slot = suffix ? '?' : '${}';
            for (const piece of pieces) next.push({ text: piece.text + slot + span.literal.text, rooted: true });
          }
        } else {
          for (const piece of pieces) {
            next.push({
              text: piece.text + hole.text + span.literal.text,
              rooted: piece.rooted || hole.text.startsWith('/'),
            });
          }
        }
      }
      if (next.length === 0 || next.length > MAX_CALL_TARGETS) return undefined;
      pieces = next;
    }
    return pieces.map((piece) => piece.text);
  }

  /**
   * True when the hole stands for a runtime base URL the model can SEE
   * derives from configuration: an identifier bound to a module-scope
   * constant whose initializer reads `import.meta.env` / `process.env`,
   * directly or through a call to a function in the scanned set that
   * does (a `getEnv(key)` helper). Such a host is dropped by the
   * template model — never proven, never invented. Anything the model
   * cannot trace to a config read is false: an unknown hole must keep
   * the call unresolved.
   */
  private isRuntimeBaseHole(
    expression: ts.Expression,
    file: string,
    bindings: ExprBinding | undefined,
    depth = 0,
  ): boolean {
    if (depth > MAX_BASE_HOPS) return false;
    const identifier = unwrapOwnExpression(expression);
    if (!ts.isIdentifier(identifier)) return false;
    const bound = bindings?.get(identifier.text);
    if (bound !== undefined) return this.isRuntimeBaseHole(bound[0], bound[1], bindings, depth + 1);
    const constant = this.resolveConstantInitializer(identifier.text, file, new Set());
    if (constant === undefined) return false;
    const [initializer, origin] = constant;
    if (referencesRuntimeEnv(initializer)) return true;
    const initCall = unwrapOwnExpression(initializer);
    if (!ts.isCallExpression(initCall) || !ts.isIdentifier(initCall.expression)) return false;
    const declared = this.functionOf(initCall.expression.text, origin);
    return declared?.body !== undefined && referencesRuntimeEnv(declared.body);
  }

  /** Path-absolute hole alternatives only. Query-shaped holes stay on the suffix model. */
  private pathHoleTargets(
    expr: ts.Expression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): readonly string[] | undefined {
    const targets = this.callTargets(expr, file, bindings, seen);
    if (targets === undefined || targets.length === 0) return undefined;
    if (!targets.every((text) => text === '' || text.startsWith('/'))) return undefined;
    return targets;
  }

  private lookupTargets(
    node: ts.ElementAccessExpression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): readonly string[] | undefined {
    const object = this.constObjectLiteral(node.expression, file, bindings, seen);
    if (object === undefined) return undefined;
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
      if (ts.isComputedPropertyName(property.name)) return undefined;
    }
    const index = node.argumentExpression;
    const selected = index !== undefined && ts.isStringLiteral(index)
      ? object.properties.filter((property) => propertyNameText(property.name) === index.text)
      : object.properties;
    if (selected.length === 0) return undefined;
    const targets: string[] = [];
    for (const property of selected) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      const part = this.callTargets(initializer, file, bindings, seen);
      if (part === undefined) return undefined;
      targets.push(...part);
      if (targets.length > MAX_CALL_TARGETS) return undefined;
    }
    return targets;
  }

  private constObjectLiteral(
    expr: ts.Expression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): ts.ObjectLiteralExpression | undefined {
    const node = unwrapOwnExpression(expr);
    if (ts.isObjectLiteralExpression(node)) return node;
    if (!ts.isIdentifier(node)) return undefined;
    const local = this.localConstBinding(node);
    if (local.state !== 'found') return undefined;
    const key = `${file}::${node.text}`;
    if (seen.has(key)) return undefined;
    const initializer = unwrapOwnExpression(local.initializer);
    return ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
  }

  private finiteFunctionTargets(
    call: ts.CallExpression,
    file: string,
    bindings: ExprBinding | undefined,
    seen: Set<string>,
  ): readonly string[] | undefined {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const name = call.expression.text;
    const local = this.localConstBinding(call.expression);
    let fn: UrlFunction | undefined;
    if (local.state === 'shadowed') return undefined;
    if (local.state === 'found') {
      const init = unwrapOwnExpression(local.initializer);
      if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return undefined;
      fn = init;
    } else {
      fn = this.modelOf(file)?.functions.get(name);
    }
    if (fn === undefined) return undefined;
    const key = `${file}::fn::${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const returns = collectUrlReturns(fn);
    if (returns === undefined) {
      seen.delete(key);
      return undefined;
    }
    const targets: string[] = [];
    for (const returned of returns) {
      const part = this.callTargets(returned, file, bindings, seen);
      if (part === undefined) {
        seen.delete(key);
        return undefined;
      }
      targets.push(...part);
      if (targets.length > MAX_CALL_TARGETS) {
        seen.delete(key);
        return undefined;
      }
    }
    seen.delete(key);
    return targets.length === 0 ? undefined : targets;
  }

  private dynamicImportAlias(
    use: ts.Identifier,
    file: string,
  ): { kind: 'builder' | 'client'; name: string } | undefined {
    const binding = this.nearestDestructure(use);
    if (binding === undefined) return undefined;
    if (binding.exported !== 'default') {
      if (activeUrlBuilderIn(this.config, binding.exported, file) !== undefined) {
        return { kind: 'builder', name: binding.exported };
      }
      if (clientSymbolActiveIn(this.config, binding.exported, file)) {
        return { kind: 'client', name: binding.exported };
      }
      return undefined;
    }
    const resolved = this.resolveSpecifier(file, binding.specifier);
    if (resolved === null) return undefined;
    const exported = defaultExportIdentifier(this.modelOf(resolved)?.source);
    if (exported === undefined || !clientSymbolActiveIn(this.config, exported, file)) return undefined;
    return { kind: 'client', name: exported };
  }

  private nearestDestructure(use: ts.Identifier): { exported: string; specifier: string } | undefined {
    let scope: ts.Node | undefined = use.parent;
    while (scope !== undefined) {
      if (ts.isFunctionLike(scope) || ts.isSourceFile(scope)) {
        const found = this.destructureInScope(use, scope);
        if (found === 'other') return undefined;
        if (found !== undefined) return found;
      }
      scope = scope.parent;
    }
    return undefined;
  }

  private destructureInScope(
    use: ts.Identifier,
    scope: ts.Node,
  ): { exported: string; specifier: string } | 'other' | undefined {
    let best: { pos: number; result: { exported: string; specifier: string } | 'other' } | undefined;
    const visit = (node: ts.Node): void => {
      if (node !== scope && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && node.name.getEnd() <= use.getStart()) {
        const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
        if (ts.isIdentifier(node.name) && node.name.text === use.text) {
          if (best === undefined || node.name.getStart() > best.pos) {
            best = { pos: node.name.getStart(), result: 'other' };
          }
        }
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name) || element.name.text !== use.text || element.dotDotDotToken !== undefined) {
              continue;
            }
            if (best !== undefined && element.name.getStart() <= best.pos) continue;
            const specifier = isConst ? awaitImportSpecifier(node.initializer) : undefined;
            const exported = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
            best = {
              pos: element.name.getStart(),
              result: specifier === undefined ? 'other' : { exported, specifier },
            };
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return best?.result;
  }

  private importedExport(file: string, localName: string): { file: string; exported: string } | null {
    const model = this.modelOf(file);
    if (model === undefined) return null;
    let found: { file: string; exported: string } | null = null;
    const visit = (node: ts.Node): void => {
      if (found !== null) return;
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
        ts.forEachChild(node, visit);
        return;
      }
      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) return;
      const resolved = this.resolveSpecifier(file, specifier);
      if (resolved === null) return;
      const clause = node.importClause;
      if (clause?.name?.text === localName) {
        found = { file: resolved, exported: 'default' };
        return;
      }
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.name.text === localName) {
            found = { file: resolved, exported: element.propertyName?.text ?? element.name.text };
            return;
          }
        }
      }
    };
    visit(model.source);
    return found;
  }
}

function modeledWrapperSpans(
  model: FileModel | undefined,
  config: ClientScanConfig,
  file: string,
): Array<readonly [number, number]> {
  if (model === undefined) return [];
  const spans: Array<readonly [number, number]> = [...model.wrappers.values()].map((wrapper) => [wrapper.start, wrapper.end]);
  for (const entry of config.wrapperFunctions ?? []) {
    if (!entryInScope(file, entry)) continue;
    const fn = model.functions.get(entry.name);
    if (fn === undefined) continue;
    if (containsClientCall(fn, config, file) || containsConfiguredWrapperCall(fn, config, file)) {
      spans.push([fn.getStart(), fn.getEnd()]);
    }
  }
  return spans;
}

function containsConfiguredWrapperCall(node: ts.Node, config: ClientScanConfig, file: string): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found || !ts.isCallExpression(current)) {
      ts.forEachChild(current, visit);
      return;
    }
    if (ts.isIdentifier(current.expression) && activeWrapperIn(config, current.expression.text, file) !== undefined) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function collectUrlReturns(fn: UrlFunction): ts.Expression[] | undefined {
  const body = fn.body;
  if (body === undefined) return undefined;
  if (!ts.isBlock(body)) return [body];
  const returns: ts.Expression[] = [];
  let poison = false;
  const visit = (node: ts.Node): void => {
    if (poison) return;
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression === undefined) {
        poison = true;
        return;
      }
      const expr = unwrapOwnExpression(node.expression);
      if (expr.kind === ts.SyntaxKind.NullKeyword) return;
      if (ts.isIdentifier(expr) && expr.text === 'undefined') return;
      returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  if (poison || returns.length === 0) return undefined;
  return returns;
}

function awaitImportSpecifier(expr: ts.Expression | undefined): string | undefined {
  if (expr === undefined) return undefined;
  const inner = unwrapOwnExpression(ts.isAwaitExpression(expr) ? expr.expression : expr);
  if (!ts.isCallExpression(inner) || inner.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const arg = inner.arguments[0];
  if (arg === undefined || !ts.isStringLiteral(arg)) return undefined;
  if (!arg.text.startsWith('./') && !arg.text.startsWith('../')) return undefined;
  return arg.text;
}

function defaultExportedFunction(model: FileModel): UrlFunction | undefined {
  for (const statement of model.source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      statement.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword) === true
    ) {
      return statement;
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return model.functions.get(statement.expression.text);
    }
  }
  return undefined;
}

function defaultExportIdentifier(source: ts.SourceFile | undefined): string | undefined {
  if (source === undefined) return undefined;
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      statement.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword) === true
    ) {
      return statement.name.text;
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return statement.expression.text;
    }
  }
  return undefined;
}

function firstIdentifierParam(fn: UrlFunction): string | undefined {
  const first = fn.parameters[0];
  return first !== undefined && ts.isIdentifier(first.name) ? first.name.text : undefined;
}

function argumentForParameter(fn: UrlFunction, paramName: string, call: ts.CallExpression): ts.Expression | undefined {
  for (let index = 0; index < fn.parameters.length; index += 1) {
    const parameter = fn.parameters[index];
    if (parameter === undefined) continue;
    if (ts.isIdentifier(parameter.name) && parameter.name.text === paramName) return call.arguments[index];
    if (!ts.isObjectBindingPattern(parameter.name)) continue;
    for (const element of parameter.name.elements) {
      if (!ts.isIdentifier(element.name) || element.name.text !== paramName) continue;
      const prop = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
      const argument = call.arguments[index];
      return argument === undefined ? undefined : objectProperty(argument, prop);
    }
  }
  return undefined;
}

function objectProperty(expr: ts.Expression, name: string): ts.Expression | undefined {
  const unwrapped = unwrapOwnExpression(expr);
  if (!ts.isObjectLiteralExpression(unwrapped)) return undefined;
  for (const property of unwrapped.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function jsxAttributeExpression(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): ts.Expression | undefined {
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name) || attr.name.text !== name) continue;
    const init = attr.initializer;
    if (init === undefined) return undefined;
    if (ts.isStringLiteral(init)) return init;
    if (ts.isJsxExpression(init) && init.expression !== undefined && ts.isExpression(init.expression)) {
      return init.expression;
    }
  }
  return undefined;
}

function resolvesToDeclaredWrapper(
  table: ValueTable,
  name: string,
  file: string,
  config: ClientScanConfig,
): boolean {
  const declared = table.findFunction(name, file);
  // No local binding: the configured name still stands, and an unmodeled
  // declaration stays a finding. A binding that is a different function
  // (same local name, other module, no client call) is not this wrapper.
  if (declared === undefined) return true;
  return containsClientCall(declared.fn, config, declared.file)
    || containsConfiguredWrapperCall(declared.fn, config, declared.file);
}

function extractJsxWrapper(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  file: string,
  config: ClientScanConfig,
  table: ValueTable,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
): void {
  if (!ts.isIdentifier(node.tagName)) return;
  const wrapperConfig = activeWrapperIn(config, node.tagName.text, file);
  if (wrapperConfig === undefined || !resolvesToDeclaredWrapper(table, wrapperConfig.name, file, config)) return;
  const source = table.modelOf(file)?.source;
  if (source === undefined) return;
  const location = locationOf(file, source, node);
  const bindings = new Map<string, readonly [ts.Expression, string]>();
  // Absent `parameter` means the first parameter — the original
  // single-parameter wrapper contract — the same fallback the direct
  // call path applies.
  const declared = table.findFunction(wrapperConfig.name, file);
  const paramName = wrapperConfig.parameter ?? (declared === undefined ? undefined : firstIdentifierParam(declared.fn));
  if (paramName !== undefined) {
    const attr = jsxAttributeExpression(node, paramName);
    if (attr !== undefined) {
      bindings.set(paramName, [attr, file]);
      if (
        resolveWrapperTargetThroughJsxProps(
          attr,
          node,
          paramName,
          wrapperConfig,
          file,
          config,
          table,
          bindings,
          calls,
          unresolved,
          location,
          [],
        )
      ) {
        return;
      }
    }
  }
  resolveExtendedWrapper(wrapperConfig, file, config, table, bindings, calls, unresolved, location, []);
}

function resolveExtendedWrapper(
  wrapperConfig: WrapperFunctionConfig,
  file: string,
  config: ClientScanConfig,
  table: ValueTable,
  bindings: ReadonlyMap<string, readonly [ts.Expression, string]>,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
  reads: ResponseRead[],
): void {
  const declared = table.findFunction(wrapperConfig.name, file);
  if (declared === undefined) {
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
  const body = wrapperBodyTargets(declared.fn, declared.file, wrapperConfig, config, table, bindings, 0, new Set());
  if (body === 'unmodeled') {
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
  if (body === 'unresolved') {
    unresolved.push({
      code: FRONTEND_CALL_TARGET_UNRESOLVED,
      detail: `call target cannot be resolved statically (${wrapperConfig.name})`,
      location,
    });
    return;
  }
  const byMethod = new Map<HttpMethod, string[]>();
  for (const target of body) {
    const list = byMethod.get(target.method) ?? [];
    list.push(target.raw);
    byMethod.set(target.method, list);
  }
  for (const [method, raws] of byMethod) {
    recordRawTargets(raws, method, wrapperConfig.name, config, calls, unresolved, location, reads);
  }
}

function wrapperBodyTargets(
  fn: UrlFunction,
  fnFile: string,
  entry: WrapperFunctionConfig,
  config: ClientScanConfig,
  table: ValueTable,
  bindings: ReadonlyMap<string, readonly [ts.Expression, string]>,
  depth: number,
  stack: Set<string>,
): { method: HttpMethod; raw: string }[] | 'unmodeled' | 'unresolved' {
  const stackKey = `${fnFile}::${entry.name}`;
  if (depth > MAX_WRAPPER_DEPTH || stack.has(stackKey)) return 'unmodeled';
  stack.add(stackKey);
  const found: { method: HttpMethod; raw: string }[] = [];
  let saw = false;
  let failed = false;
  const visit = (node: ts.Node): void => {
    if (failed || !ts.isCallExpression(node)) {
      if (!failed) ts.forEachChild(node, visit);
      return;
    }
    const client = clientCallOf(node, config, fnFile, table, bindings);
    if (client !== undefined) {
      saw = true;
      if (entry.methodFromBody === true) {
        // The verb comes from the body: nothing provable means no call
        // fact — never an invented default.
        if (client.method === null) {
          failed = true;
          return;
        }
      } else if (client.method !== null && client.method !== entry.method) {
        // The declaration governs, but a body that PROVES another verb
        // contradicts it; an unproven body (options spread of unknown
        // provenance) does not.
        failed = true;
        return;
      }
      const targets = table.callTargets(client.url, fnFile, bindings);
      if (targets === undefined) {
        failed = true;
        return;
      }
      // Surviving the checks above, a proven body verb equals the
      // declaration (or governs via methodFromBody); only an unproven
      // body under a declared method reaches here as null.
      const method: HttpMethod = client.method ?? entry.method;
      for (const raw of targets) found.push({ method, raw });
      return;
    }
    const nestedName = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    const nested = nestedName === undefined ? undefined : activeWrapperIn(config, nestedName, fnFile);
    if (nested !== undefined && nested.name !== entry.name) {
      saw = true;
      const innerFn = table.findFunction(nested.name, fnFile);
      if (innerFn === undefined) {
        failed = true;
        return;
      }
      const paramName = nested.parameter ?? firstIdentifierParam(innerFn.fn);
      const next = new Map(bindings);
      if (paramName !== undefined) {
        const argument = argumentForParameter(innerFn.fn, paramName, node);
        if (argument !== undefined) {
          const followed = ts.isIdentifier(argument) ? bindings.get(argument.text) : undefined;
          next.set(paramName, followed ?? [argument, fnFile]);
        }
      }
      const inner = wrapperBodyTargets(innerFn.fn, innerFn.file, nested, config, table, next, depth + 1, stack);
      if (inner === 'unmodeled' || inner === 'unresolved') {
        failed = true;
        return;
      }
      found.push(...inner);
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body !== undefined) visit(fn.body);
  stack.delete(stackKey);
  if (!saw) return 'unmodeled';
  if (failed || found.length === 0) return 'unresolved';
  return found;
}

/**
 * The configured client symbol an `X.interceptors.response.use(...)`
 * call registers on, or null when the call is not such a registration
 * on `axios` or a configured client symbol. Request interceptors are
 * deliberately out of scope: a request-side handler edits the config
 * BEFORE the first send, so a re-send modeled there would record a call
 * the scan has never seen.
 */
function interceptorReplayClient(
  call: ts.CallExpression,
  file: string,
  config: ClientScanConfig,
): string | null {
  const use = call.expression;
  if (!ts.isPropertyAccessExpression(use) || use.name.text !== 'use') return null;
  const response = use.expression;
  if (!ts.isPropertyAccessExpression(response) || response.name.text !== 'response') return null;
  const interceptors = response.expression;
  if (!ts.isPropertyAccessExpression(interceptors) || interceptors.name.text !== 'interceptors') return null;
  const client = interceptors.expression;
  if (!ts.isIdentifier(client)) return null;
  if (client.text !== 'axios' && !clientSymbolActiveIn(config, client.text, file)) return null;
  return client.text;
}

/** `error.config` for the handler's own error parameter — and nothing else. */
function isOwnErrorConfig(expr: ts.Expression | undefined, errorParamName: string | undefined): boolean {
  if (errorParamName === undefined || expr === undefined) return false;
  // Real handlers type the config on the way through — PM's
  // `const config = error.config as RetriableConfig | undefined;` — so
  // the alias must be recognized through as/satisfies/non-null/parens.
  const peeled = unwrapOwnExpression(expr);
  return (
    ts.isPropertyAccessExpression(peeled) &&
    ts.isIdentifier(peeled.expression) &&
    peeled.expression.text === errorParamName &&
    peeled.name.text === 'config'
  );
}

/**
 * Records the replay calls a response-error handler performs: calls on
 * the SAME client symbol whose single argument is the intercepted
 * error's own request config — `error.config`, a destructured
 * `{ config }` parameter binding, or a `const` bound to `error.config`.
 * Everything else inside the handler keeps today's model — a different
 * symbol, a different argument, a second argument, a verb call — because
 * only the re-send-the-original-request shape is a replay of a request
 * this scan has already recorded.
 */
function collectInterceptorReplays(
  call: ts.CallExpression,
  file: string,
  config: ClientScanConfig,
  replayCalls: Set<ts.CallExpression>,
): void {
  const clientName = interceptorReplayClient(call, file, config);
  if (clientName === null) return;
  const handler = call.arguments[1];
  if (handler === undefined || (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler))) return;
  const first = handler.parameters[0];
  if (first === undefined) return;
  let errorParamName: string | undefined;
  const boundConfigNames = new Set<string>();
  if (ts.isIdentifier(first.name)) {
    errorParamName = first.name.text;
  } else if (ts.isObjectBindingPattern(first.name)) {
    for (const element of first.name.elements) {
      if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
      const propertyName = element.propertyName === undefined
        ? element.name.text
        : ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : undefined;
      if (propertyName === 'config') boundConfigNames.add(element.name.text);
    }
  } else {
    return;
  }
  const configAliases = new Set<string>();
  if (errorParamName !== undefined && handler.body !== undefined) {
    const collectAlias = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        isOwnErrorConfig(node.initializer, errorParamName)
      ) {
        configAliases.add(node.name.text);
      }
      ts.forEachChild(node, collectAlias);
    };
    collectAlias(handler.body);
  }
  if (handler.body === undefined) return;
  const collectReplays = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const argument = node.arguments[0];
      if (
        ts.isIdentifier(expression) &&
        expression.text === clientName &&
        node.arguments.length === 1 &&
        argument !== undefined &&
        (isOwnErrorConfig(argument, errorParamName) ||
          (ts.isIdentifier(argument) && (boundConfigNames.has(argument.text) || configAliases.has(argument.text))))
      ) {
        replayCalls.add(node);
        return;
      }
    }
    ts.forEachChild(node, collectReplays);
  };
  collectReplays(handler.body);
}

/** One scanned function-like that models a JSX component: first parameter is `props` or destructured. */
interface ComponentModel {
  name: string;
  file: string;
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  source: ts.SourceFile;
}

/** Components in the scanned set and every JSX element that instantiates them. */
interface JsxComponentIndex {
  components: Map<string, ComponentModel>;
  usages: Map<string, Array<{ file: string; element: ts.JsxOpeningElement | ts.JsxSelfClosingElement }>>;
}

const jsxComponentIndexCache = new WeakMap<ValueTable, JsxComponentIndex>();

/**
 * Builds (once per scan) the component/usage index the JSX prop flow
 * resolves through: module-scope function-likes whose first parameter is
 * `props` or destructured, plus every JSX element with an identifier
 * tagName. The whole scanned set participates — usage sites are
 * dataflow inputs, and scan scoping narrows fact emission, not the
 * dataflow's ability to resolve product code.
 */
function jsxComponentIndex(table: ValueTable): JsxComponentIndex {
  const cached = jsxComponentIndexCache.get(table);
  if (cached !== undefined) return cached;
  const index: JsxComponentIndex = { components: new Map(), usages: new Map() };
  for (const file of [...table.scannedFiles.keys()].sort()) {
    const model = table.modelOf(file);
    if (model === undefined) continue;
    for (const [name, fn] of model.functions) {
      if (index.components.has(name)) continue;
      const first = fn.parameters[0];
      if (first === undefined) continue;
      if (!ts.isIdentifier(first.name) && !ts.isObjectBindingPattern(first.name)) continue;
      index.components.set(name, { name, file, fn, source: model.source });
    }
    const collectUsages = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        if (ts.isIdentifier(node.tagName)) {
          const sites = index.usages.get(node.tagName.text) ?? [];
          sites.push({ file, element: node });
          index.usages.set(node.tagName.text, sites);
        }
      }
      ts.forEachChild(node, collectUsages);
    };
    collectUsages(model.source);
  }
  jsxComponentIndexCache.set(table, index);
  return index;
}

/**
 * The prop name `localName` binds inside a destructured first parameter,
 * or undefined. Renames count (`{ apiEndpoint: endpoint }` binds the
 * `apiEndpoint` prop under the local `endpoint`); rest elements and
 * non-identifier names bind nothing — an unbound name fails closed.
 */
function componentPropName(component: ComponentModel, localName: string): string | undefined {
  const first = component.fn.parameters[0];
  if (first === undefined || !ts.isObjectBindingPattern(first.name)) return undefined;
  for (const element of first.name.elements) {
    if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
    const propName = element.propertyName === undefined
      ? element.name.text
      : ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : undefined;
    if (propName !== undefined && element.name.text === localName) return propName;
  }
  return undefined;
}

/**
 * The component-prop reference an expression resolves to inside
 * `component`: a destructured prop (`apiEndpoint`), a `props.` access
 * (`props.apiEndpoint`), either with a member path (`duplicate.apiBasePath`,
 * `props.row.apiBasePath`). Undefined for anything else.
 */
function componentPropRef(
  expr: ts.Expression,
  component: ComponentModel,
): { propName: string; path: readonly string[] } | undefined {
  const first = component.fn.parameters[0];
  if (first === undefined) return undefined;
  const takesPropsObject = ts.isIdentifier(first.name) && first.name.text === 'props';
  const segments: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return undefined;
  if (segments.length === 0) {
    const propName = componentPropName(component, current.text);
    return propName === undefined ? undefined : { propName, path: [] };
  }
  if (takesPropsObject && current.text === 'props') {
    const propName = segments[0];
    return propName === undefined ? undefined : { propName, path: segments.slice(1) };
  }
  const propName = componentPropName(component, current.text);
  return propName === undefined ? undefined : { propName, path: segments };
}

/** The innermost indexed component of `file` whose span contains `node`. */
function innermostComponent(
  components: ReadonlyMap<string, ComponentModel>,
  file: string,
  node: ts.Node,
): ComponentModel | undefined {
  let best: ComponentModel | undefined;
  let bestStart = -1;
  for (const component of components.values()) {
    if (component.file !== file) continue;
    const start = component.fn.getStart(component.source);
    if (node.getStart(component.source) < start || node.getEnd() > component.fn.getEnd()) continue;
    if (best === undefined || start > bestStart) {
      best = component;
      bestStart = start;
    }
  }
  return best;
}

/**
 * Every target a component prop provably carries, read off the
 * component's JSX usage sites in the scanned set. Each site must pass a
 * literal or statically resolvable value; a value may also forward
 * another component's prop unchanged, which resolves through THAT
 * component's sites — exactly one hop, then the value must be concrete.
 * A missing attribute, an unresolvable value, a second hop, or a
 * component without usage sites fails closed: a guessed target would
 * certify a route the server may never serve.
 */
function propTargetsThroughUsages(
  index: JsxComponentIndex,
  component: ComponentModel,
  propName: string,
  depth: number,
  stack: ReadonlySet<string>,
  table: ValueTable,
): readonly string[] | 'unresolved' {
  const stackKey = `${component.file}::${component.name}::${propName}`;
  if (stack.has(stackKey)) return 'unresolved';
  const sites = index.usages.get(component.name);
  if (sites === undefined || sites.length === 0) return 'unresolved';
  const nextStack = new Set(stack);
  nextStack.add(stackKey);
  const targets: string[] = [];
  for (const site of sites) {
    const attr = jsxAttributeExpression(site.element, propName);
    if (attr === undefined) return 'unresolved';
    const enclosing = innermostComponent(index.components, site.file, site.element);
    if (enclosing !== undefined) {
      const forwarded = componentPropRef(attr, enclosing);
      if (forwarded !== undefined) {
        if (forwarded.path.length > 0 || depth >= 1) return 'unresolved';
        const deeper = propTargetsThroughUsages(index, enclosing, forwarded.propName, depth + 1, nextStack, table);
        if (deeper === 'unresolved') return 'unresolved';
        targets.push(...deeper);
        continue;
      }
    }
    const direct = table.callTargets(attr, site.file);
    if (direct === undefined || direct.length === 0) return 'unresolved';
    targets.push(...direct);
  }
  return targets;
}

/** True for exactly the literal scalars a destructuring default may take: string, number, boolean, null, undefined. */
function isLiteralScalar(expr: ts.Expression): boolean {
  const unwrapped = unwrapOwnExpression(expr);
  return unwrapped.kind === ts.SyntaxKind.NullKeyword
    || unwrapped.kind === ts.SyntaxKind.TrueKeyword
    || unwrapped.kind === ts.SyntaxKind.FalseKeyword
    || ts.isStringLiteral(unwrapped)
    || ts.isNoSubstitutionTemplateLiteral(unwrapped)
    || ts.isNumericLiteral(unwrapped)
    || (ts.isPrefixUnaryExpression(unwrapped)
      && unwrapped.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(unwrapped.operand))
    || (ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined');
}

/**
 * The literal initializer a destructured prop binds when its attribute
 * is omitted, or undefined. Renames count (`{ apiEndpoint: endpoint =
 * '/x/' }`); anything beyond a literal scalar — a call, an identifier,
 * a computed value — is not a provable default and fails closed, as
 * does a prop declared without an initializer.
 */
function componentPropDefault(component: ComponentModel, propName: string): ts.Expression | undefined {
  const first = component.fn.parameters[0];
  if (first === undefined || !ts.isObjectBindingPattern(first.name)) return undefined;
  for (const element of first.name.elements) {
    if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
    const bound = element.propertyName === undefined
      ? element.name.text
      : ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : undefined;
    if (bound !== propName) continue;
    const initializer = element.initializer;
    if (initializer === undefined) return undefined;
    return isLiteralScalar(initializer) ? initializer : undefined;
  }
  return undefined;
}

/**
 * The argument's identifiers that name one of the component's
 * destructured props — the value references a per-usage binding must
 * cover. Property-access names (`x.detail`) and object-literal keys
 * are positions, not value references.
 */
function argumentPropLocals(argument: ts.Expression, component: ComponentModel): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && componentPropName(component, node.text) !== undefined && !isPositionalName(node)) {
      names.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(argument);
  return names;
}

/** True when `node` sits in a property-name position rather than a value position. */
function isPositionalName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  return false;
}

/**
 * One usage site's binding of the referenced destructured props to
 * statically known values: the attribute the site passes, or — when
 * the site omits the attribute — the prop's literal destructuring
 * default (evaluated in the component's file). A prop whose value
 * cannot be proven at this site (omitted with no default or with a
 * non-literal default, attribute present without a value) binds to
 * `UNPROVEN_PROP_VALUE`: the evaluation fails only if it consults the
 * prop, so a guard the URL never reads cannot block a provable target.
 * Undefined when the site cannot bind the props AT ALL: a spread
 * attribute (`{...props}`) may carry any of them with unknown values.
 * Undefined fails closed at the caller.
 */
function usagePropBindings(
  component: ComponentModel,
  site: { file: string; element: ts.JsxOpeningElement | ts.JsxSelfClosingElement },
  referenced: ReadonlySet<string>,
): ExprBinding | undefined {
  for (const attribute of site.element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) return undefined;
  }
  const bindings = new Map<string, readonly [ts.Expression, string]>();
  for (const localName of referenced) {
    const propName = componentPropName(component, localName);
    if (propName === undefined) return undefined;
    const attribute = jsxAttributeExpression(site.element, propName);
    if (attribute !== undefined) {
      bindings.set(localName, [attribute, site.file]);
      continue;
    }
    let presentWithoutValue = false;
    for (const attribute of site.element.attributes.properties) {
      if (ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === propName) {
        presentWithoutValue = true;
        break;
      }
    }
    if (presentWithoutValue) {
      bindings.set(localName, [UNPROVEN_PROP_VALUE, component.file]);
      continue;
    }
    const initializer = componentPropDefault(component, propName);
    if (initializer === undefined) {
      bindings.set(localName, [UNPROVEN_PROP_VALUE, component.file]);
      continue;
    }
    bindings.set(localName, [initializer, component.file]);
  }
  return bindings;
}

/**
 * Decides a wrapper call whose endpoint argument DEPENDS on the host
 * component's props without being a bare prop reference — a ternary
 * guard like ``detail === null ? `${base}/x` : `${detail}/x` `` over a
 * destructured prop. Every JSX usage site of the component contributes
 * a value for each prop the argument references (the attribute passed,
 * or the prop's literal destructuring default when omitted), and the
 * argument is evaluated once per usage under those bindings: a
 * null/undefined default proves the guard and selects the matching
 * branch. The wrapper is then evaluated once per distinct resolved
 * target, emitting one call per distinct target. A usage that cannot
 * bind a referenced prop keeps today's unresolved finding, byte for
 * byte. Everything the resolver cannot itself prove — a host without
 * JSX usage sites (a hook), a usage-supplied value that still leaves
 * the argument unproven — defers: the caller falls through to the
 * plain configured-parameter model, which fails closed on its own.
 * Returns false when the argument references none of the component's
 * props — the caller keeps today's model.
 */
function resolveWrapperTargetThroughPropDefaults(
  argument: ts.Expression,
  host: ComponentModel,
  paramName: string,
  wrapperConfig: WrapperFunctionConfig,
  file: string,
  config: ClientScanConfig,
  table: ValueTable,
  baseBindings: ReadonlyMap<string, readonly [ts.Expression, string]>,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
  reads: ResponseRead[],
): boolean {
  const referenced = argumentPropLocals(argument, host);
  if (referenced.size === 0) return false;
  const object = unwrapOwnExpression(argument);
  if (ts.isObjectLiteralExpression(object)) {
    return recordWrapperTargetsThroughObjectProps(
      object,
      host,
      wrapperConfig,
      file,
      config,
      table,
      calls,
      unresolved,
      location,
      reads,
    );
  }
  const index = jsxComponentIndex(table);
  const sites = index.usages.get(host.name);
  if (sites === undefined || sites.length === 0) {
    // A host with no JSX usage sites (a hook called from other hooks)
    // has no per-usage values; the plain configured-parameter model may
    // still resolve the call. Defer rather than preempt it with a
    // finding the baseline did not emit.
    return false;
  }
  const targets: string[] = [];
  for (const site of sites) {
    const bindings = usagePropBindings(host, site, referenced);
    if (bindings === undefined) {
      unresolved.push({
        code: FRONTEND_CALL_TARGET_UNRESOLVED,
        detail: `call target cannot be resolved statically (${wrapperConfig.name})`,
        location,
      });
      return true;
    }
    const resolved = table.callTargets(argument, file, bindings);
    if (resolved === undefined || resolved.length === 0) {
      // The usage supplied values, but the argument still cannot be
      // proven under them. The plain configured-parameter model may
      // resolve the call more coarsely (an unbound hole becomes a
      // `${}` slot exactly as before this resolver existed). Defer.
      return false;
    }
    targets.push(...resolved);
  }
  return recordWrapperTargets(
    targets,
    paramName,
    wrapperConfig,
    file,
    config,
    table,
    baseBindings,
    calls,
    unresolved,
    location,
    reads,
  );
}

/**
 * The hook-body bindings one config-object call argument carries: each
 * property binds the hook's destructured local to the property's value.
 * A value that NAMES a host prop resolves through that usage's prop
 * bindings (the passed attribute, or the literal destructuring
 * default); any other value binds as written and must resolve in the
 * call file. Undefined — fail closed — for shorthand properties whose
 * name is not a per-usage-known prop, for spread elements, and for
 * computed or method properties: what they carry cannot be proven.
 */
function objectUsageBindings(
  object: ts.ObjectLiteralExpression,
  host: ComponentModel,
  usage: ExprBinding,
  callFile: string,
): ExprBinding | undefined {
  const bindings = new Map<string, readonly [ts.Expression, string]>();
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      const value = unwrapOwnExpression(property.initializer);
      if (ts.isIdentifier(value) && componentPropName(host, value.text) !== undefined) {
        const bound = usage.get(value.text);
        if (bound === undefined) return undefined;
        bindings.set(property.name.text, bound);
      } else {
        bindings.set(property.name.text, [property.initializer, callFile]);
      }
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const bound = usage.get(property.name.text);
      if (bound !== undefined) {
        bindings.set(property.name.text, bound);
      } else {
        bindings.set(property.name.text, [property.name, callFile]);
      }
      continue;
    }
    return undefined;
  }
  return bindings;
}

/**
 * Decides a wrapper call whose argument is a config OBJECT carrying the
 * host component's props into a destructured hook parameter —
 * `useSearchableDropdown({ endpoint: apiEndpoint, detailEndpoint })`.
 * Every JSX usage site of the component contributes the values it
 * passes and the literal destructuring defaults it omits; the hook
 * body is then evaluated once per usage under those bindings, so a
 * null/undefined default proves a guard inside the HOOK and selects
 * the matching branch. Raws are unioned across usages and recorded
 * once per distinct path per method. A usage that cannot bind a
 * referenced prop keeps today's unresolved finding, byte for byte.
 * Everything the resolver cannot itself prove — a host without JSX
 * usage sites (a hook), a hook body that stays unproven or a wrapper
 * with no modeled client call — defers: the caller falls through to
 * the plain configured-parameter model, which fails closed on its
 * own. Returns false when the object references none of the
 * component's props or the wrapper has no simple single-return client
 * call — the caller keeps today's model.
 */
function recordWrapperTargetsThroughObjectProps(
  object: ts.ObjectLiteralExpression,
  host: ComponentModel,
  wrapperConfig: WrapperFunctionConfig,
  file: string,
  config: ClientScanConfig,
  table: ValueTable,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
  reads: ResponseRead[],
): boolean {
  const referenced = argumentPropLocals(object, host);
  if (referenced.size === 0) return false;
  const index = jsxComponentIndex(table);
  const sites = index.usages.get(host.name);
  if (sites === undefined || sites.length === 0) {
    // A host with no JSX usage sites (a hook called from other hooks)
    // has no per-usage values; the plain configured-parameter model may
    // still resolve the call. Defer rather than preempt it with a
    // finding the baseline did not emit.
    return false;
  }
  const declared = table.findFunction(wrapperConfig.name, file);
  if (declared === undefined) return false;
  const byMethod = new Map<HttpMethod, string[]>();
  for (const site of sites) {
    const usage = usagePropBindings(host, site, referenced);
    if (usage === undefined) {
      unresolved.push({
        code: FRONTEND_CALL_TARGET_UNRESOLVED,
        detail: `call target cannot be resolved statically (${wrapperConfig.name})`,
        location,
      });
      return true;
    }
    const bodyBindings = objectUsageBindings(object, host, usage, file);
    if (bodyBindings === undefined) {
      unresolved.push({
        code: FRONTEND_CALL_TARGET_UNRESOLVED,
        detail: `call target cannot be resolved statically (${wrapperConfig.name})`,
        location,
      });
      return true;
    }
    const body = wrapperBodyTargets(declared.fn, declared.file, wrapperConfig, config, table, bodyBindings, 0, new Set());
    if (body === 'unmodeled') {
      // The wrapper itself is not modeled - the plain extended-wrapper
      // model below emits exactly this finding with today's wording.
      // Defer so the wording and the fallback stay in one place.
      return false;
    }
    if (body === 'unresolved') {
      // The hook body cannot be proven under the per-usage values. The
      // plain configured-parameter model may still resolve the call
      // more coarsely (unbound holes become `${}` slots). Defer.
      return false;
    }
    for (const entry of body) {
      const raws = byMethod.get(entry.method) ?? [];
      raws.push(entry.raw);
      byMethod.set(entry.method, raws);
    }
  }
  for (const [method, raws] of byMethod) {
    recordRawTargets([...new Set(raws)], method, wrapperConfig.name, config, calls, unresolved, location, reads);
  }
  return true;
}

/**
 * Decides a wrapper call whose POSITIONAL arguments carry the host
 * component's props — `useSearchableDropdown(apiEndpoint,
 * detailEndpoint)`, or a config object the single-argument model
 * cannot bind (`parameter`-extracted or destructured-parameter
 * shapes). Runs after the single-argument chain: it engages only the
 * calls that chain left unresolved. Every JSX usage site of the host
 * component contributes the values it passes and the literal
 * destructuring defaults it omits; each declared parameter binds its
 * call argument (a bare prop resolves through that usage's bindings),
 * the referenced prop locals bind for complex arguments, and the hook
 * body is evaluated once per usage. Raws are unioned across usages and
 * recorded once per distinct path per method. The resolver is a
 * precision upgrade only: every failure to bind or prove — a host
 * without JSX usage sites (a hook), a usage that cannot bind a
 * referenced prop, an unbindable argument, an unproven hook body —
 * defers to the plain configured-parameter model, which resolves or
 * fails closed exactly as before this resolver existed. Returns false
 * when no argument references one of the component's props — the
 * caller keeps today's model.
 */
function resolveWrapperTargetsThroughPositionalArgs(
  call: ts.CallExpression,
  declared: { fn: UrlFunction; file: string },
  wrapperConfig: WrapperFunctionConfig,
  file: string,
  config: ClientScanConfig,
  table: ValueTable,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
  reads: ResponseRead[],
): boolean {
  const index = jsxComponentIndex(table);
  const host = innermostComponent(index.components, file, call);
  if (host === undefined) return false;
  const referenced = new Set<string>();
  for (const argument of call.arguments) {
    for (const name of argumentPropLocals(argument, host)) referenced.add(name);
  }
  if (referenced.size === 0) return false;
  const sites = index.usages.get(host.name);
  if (sites === undefined || sites.length === 0) {
    // A host with no JSX usage sites (a hook called from other hooks,
    // never rendered) has no per-usage values to bind - but the plain
    // configured-parameter model may still resolve the call. Defer;
    // claiming it here would turn every hook-to-hook call into a
    // finding the baseline did not emit.
    return false;
  }
  const byMethod = new Map<HttpMethod, string[]>();
  for (const site of sites) {
    const usage = usagePropBindings(host, site, referenced);
    if (usage === undefined) {
      unresolved.push({
        code: FRONTEND_CALL_TARGET_UNRESOLVED,
        detail: `call target cannot be resolved statically (${wrapperConfig.name})`,
        location,
      });
      return true;
    }
    const bodyBindings = new Map<string, readonly [ts.Expression, string]>();
    for (const localName of referenced) {
      const bound = usage.get(localName);
      if (bound !== undefined) bodyBindings.set(localName, bound);
    }
    let unbindable = false;
    for (let paramIndex = 0; paramIndex < declared.fn.parameters.length; paramIndex += 1) {
      const parameter = declared.fn.parameters[paramIndex];
      const argument = call.arguments[paramIndex];
      if (parameter === undefined || argument === undefined) continue;
      if (ts.isIdentifier(parameter.name)) {
        const value = unwrapOwnExpression(argument);
        if (ts.isIdentifier(value) && componentPropName(host, value.text) !== undefined) {
          const bound = usage.get(value.text);
          if (bound === undefined) {
            unbindable = true;
            break;
          }
          bodyBindings.set(parameter.name.text, bound);
        } else {
          bodyBindings.set(parameter.name.text, [argument, file]);
        }
        continue;
      }
      if (ts.isObjectBindingPattern(parameter.name)) {
        const object = unwrapOwnExpression(argument);
        if (!ts.isObjectLiteralExpression(object)) {
          unbindable = true;
          break;
        }
        const objectBindings = objectUsageBindings(object, host, usage, file);
        if (objectBindings === undefined) {
          unbindable = true;
          break;
        }
        for (const [name, bound] of objectBindings) bodyBindings.set(name, bound);
      }
    }
    if (unbindable) {
      // This call's arguments cannot be bound per usage. Defer: the
      // plain configured-parameter model decides, keeping today's
      // finding when it cannot resolve the call either.
      return false;
    }
    const body = wrapperBodyTargets(declared.fn, declared.file, wrapperConfig, config, table, bodyBindings, 0, new Set());
    if (body === 'unmodeled') {
      // The wrapper itself is not modeled - the plain extended-wrapper
      // model below emits exactly this finding with today's wording.
      // Defer so the wording and the fallback stay in one place.
      return false;
    }
    if (body === 'unresolved') {
      // The hook body cannot be proven under the per-usage values. The
      // plain configured-parameter model may still resolve the call
      // more coarsely (unbound holes become `${}` slots). Defer.
      return false;
    }
    for (const entry of body) {
      const raws = byMethod.get(entry.method) ?? [];
      raws.push(entry.raw);
      byMethod.set(entry.method, raws);
    }
  }
  for (const [method, raws] of byMethod) {
    recordRawTargets([...new Set(raws)], method, wrapperConfig.name, config, calls, unresolved, location, reads);
  }
  return true;
}

/**
 * Emits the wrapper's calls for an already-resolved set of endpoint
 * targets: the declared wrapper body is evaluated once per distinct
 * target with the target bound to the wrapper's parameter, and the
 * raws are recorded per method. Returns false when the wrapper has no
 * simple single-return client call in the scanned set — the caller
 * keeps today's model. A body that cannot be evaluated keeps today's
 * unresolved finding.
 */
function recordWrapperTargets(
  targets: readonly string[],
  paramName: string,
  wrapperConfig: WrapperFunctionConfig,
  file: string,
  config: ClientScanConfig,
  table: ValueTable,
  baseBindings: ReadonlyMap<string, readonly [ts.Expression, string]>,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
  reads: ResponseRead[],
): boolean {
  const declared = table.findFunction(wrapperConfig.name, file);
  if (declared === undefined) return false;
  const byMethod = new Map<HttpMethod, string[]>();
  for (const target of new Set(targets)) {
    const bindings = new Map(baseBindings);
    bindings.set(paramName, [ts.factory.createStringLiteral(target), file]);
    const body = wrapperBodyTargets(declared.fn, declared.file, wrapperConfig, config, table, bindings, 0, new Set());
    if (body === 'unmodeled' || body === 'unresolved') {
      unresolved.push({
        code: FRONTEND_CALL_TARGET_UNRESOLVED,
        detail: `call target cannot be resolved statically (${wrapperConfig.name})`,
        location,
      });
      return true;
    }
    for (const entry of body) {
      const raws = byMethod.get(entry.method) ?? [];
      raws.push(entry.raw);
      byMethod.set(entry.method, raws);
    }
  }
  for (const [method, raws] of byMethod) {
    recordRawTargets([...new Set(raws)], method, wrapperConfig.name, config, calls, unresolved, location, reads);
  }
  return true;
}

/**
 * Decides a wrapper call whose endpoint argument is a prop of the
 * enclosing function component: the prop is resolved through every JSX
 * usage site of that component (one forwarding hop allowed) and the
 * wrapper is evaluated once per distinct resolved target, emitting one
 * call per distinct target. When the argument is not a bare
 * component-prop reference, the argument is resolved through the
 * component's destructuring defaults instead (see
 * resolveWrapperTargetThroughPropDefaults); when it references no
 * destructured prop either, the caller keeps today's model. A prop the
 * usage sites cannot resolve keeps today's unresolved finding, byte for
 * byte.
 */
function resolveWrapperTargetThroughJsxProps(
  argument: ts.Expression,
  hostNode: ts.Node,
  paramName: string,
  wrapperConfig: WrapperFunctionConfig,
  file: string,
  config: ClientScanConfig,
  table: ValueTable,
  baseBindings: ReadonlyMap<string, readonly [ts.Expression, string]>,
  calls: ClientCall[],
  unresolved: ClientScanUnresolved[],
  location: Location,
  reads: ResponseRead[],
): boolean {
  const index = jsxComponentIndex(table);
  const host = innermostComponent(index.components, file, hostNode);
  if (host === undefined) return false;
  const ref = componentPropRef(unwrapOwnExpression(argument), host);
  if (ref === undefined || ref.path.length > 0) {
    return resolveWrapperTargetThroughPropDefaults(
      argument,
      host,
      paramName,
      wrapperConfig,
      file,
      config,
      table,
      baseBindings,
      calls,
      unresolved,
      location,
      reads,
    );
  }
  const targets = propTargetsThroughUsages(index, host, ref.propName, 0, new Set(), table);
  if (targets === 'unresolved') {
    unresolved.push({
      code: FRONTEND_CALL_TARGET_UNRESOLVED,
      detail: `call target cannot be resolved statically (${wrapperConfig.name})`,
      location,
    });
    return true;
  }
  return recordWrapperTargets(
    targets,
    paramName,
    wrapperConfig,
    file,
    config,
    table,
    baseBindings,
    calls,
    unresolved,
    location,
    reads,
  );
}

function clientCallOf(
  call: ts.CallExpression,
  config: ClientScanConfig,
  file: string,
  table: ValueTable,
  bindings?: ExprBinding,
): { url: ts.Expression; method: HttpMethod | null } | undefined {
  const expression = call.expression;
  if (ts.isIdentifier(expression) && expression.text === 'fetch' && !table.shadowsGlobalFetch(expression)) {
    const url = call.arguments[0];
    if (url === undefined) return undefined;
    const optionsNode = call.arguments[1];
    if (optionsNode === undefined) return { url, method: 'GET' };
    if (
      ts.isObjectLiteralExpression(optionsNode) &&
      !optionsNode.properties.some(ts.isSpreadAssignment)
    ) {
      // A plain literal: the direct-call scan decides its verb — the
      // wrapper-body model keeps today's GET default here.
      return { url, method: 'GET' };
    }
    // A spread-carrying literal or options built elsewhere: the verb is
    // whatever the CALL SITE's argument proves through the bounded
    // options model — `null` when nothing is proven (never a GET).
    const resolved = table.optionsMethod(optionsNode, file, bindings);
    if (resolved.kind === 'unproven') return { url, method: null };
    return { url, method: resolved.kind === 'proven' ? resolved.method : 'GET' };
  }
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
  const objectName = table.configuredClientName(expression.expression, file);
  const verb = expression.name.text.toLowerCase();
  if (!(objectName === 'axios' || clientSymbolActiveIn(config, objectName, file)) || !VERB_METHODS.has(verb)) {
    return undefined;
  }
  const url = call.arguments[0];
  if (url === undefined) return undefined;
  return { url, method: VERB_METHODS.get(verb) ?? 'GET' };
}

/**
 * Validates the include/exclude scoping fields of one object-form
 * entry. New surface, so strict: a present-but-not-array include or
 * exclude is malformed and throws (fail closed — silently ignoring a
 * scoping directive would scan MORE than the configuration asked for,
 * resurfacing the harness false positives scoping exists to remove).
 */
function parseEntryScoping(
  record: Record<string, unknown>,
  kind: string,
  path: string,
): { include?: string[]; exclude?: string[] } {
  const scoping: { include?: string[]; exclude?: string[] } = {};
  for (const key of ['include', 'exclude'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new Error(`invalid http client config: ${kind} '${String(record['name'])}' ${key} must be an array of globs at ${path}`);
    }
    scoping[key] = value.map((glob) => String(glob));
  }
  return scoping;
}

/**
 * Parses the WHOLE client-scan document — every key of the owner's
 * `scan.httpClients` section (0.11.0: these bytes used to live in
 * `.gateforge/http-clients.json`, and the host handed them over
 * instead of letting every detector re-read a file).
 *
 * An ABSENT section is normal and yields the default config (no roots,
 * no symbols) — byte-identical to the absent document. A malformed one
 * throws (fail closed — the CLI surfaces the error instead of scanning
 * with partial trust).
 *
 * Accepted shapes (phase 3 scan-scoping): `clientSymbols` entries are a
 * plain string (back-compat, unscoped) or `{ name, include?, exclude? }`;
 * `wrapperFunctions` / `urlBuilders` entries carry the same optional
 * include/exclude next to their existing `method` / `base` fields; the
 * top-level `clientScanRoots` / `serverScanRoots` arrays scope where
 * client-call and server-route scanning apply at all. Consistent with the
 * pre-existing parser posture: unknown keys are ignored, non-array known
 * keys are ignored, but malformed ENTRY values throw (the wrapper verb
 * check predates this; the scoping fields throw on wrong shapes and
 * missing names because silently dropping a scope widens the scan
 * instead of narrowing it).
 *
 * Args:
 *   section: the parsed `scan.httpClients` section, or null/undefined when absent.
 *   at: where the bytes came from, named in every refusal.
 *
 * Returns:
 *   ClientScanConfig: the validated configuration.
 */
export function parseClientScanConfigDocument(section: unknown, at: string): ClientScanConfig {
  if (section === null || section === undefined) return DEFAULT_CLIENT_SCAN_CONFIG;
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(`invalid http client config: expected an object at ${at}`);
  }
  const document = section as Record<string, unknown>;
  const config: ClientScanConfig = {};
  if (Array.isArray(document['clientScanRoots'])) {
    config.clientScanRoots = document['clientScanRoots'].map((root) => String(root));
  }
  if (Array.isArray(document['serverScanRoots'])) {
    config.serverScanRoots = document['serverScanRoots'].map((root) => String(root));
  }
  if (Array.isArray(document['clientSymbols'])) {
    config.clientSymbols = document['clientSymbols'].map((entry) => {
      // Plain string: the original shape, unscoped — byte-identical.
      if (typeof entry === 'string') return entry;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`invalid http client config: clientSymbols entries must be a name or a {name, include?, exclude?} object at ${at}`);
      }
      const record = entry as Record<string, unknown>;
      if (record['name'] === undefined) {
        throw new Error(`invalid http client config: clientSymbols object entries must carry a name at ${at}`);
      }
      return { name: String(record['name']), ...parseEntryScoping(record, 'clientSymbols', at) };
    });
  }
  if (Array.isArray(document['wrapperFunctions'])) {
    config.wrapperFunctions = document['wrapperFunctions'].map((entry) => {
      const record = entry as Record<string, unknown>;
      const methodFromBody = record['methodFromBody'] === true;
      const method = methodFromBody && record['method'] === undefined
        ? 'GET'
        : normalizeHttpMethodValue(String(record['method'] ?? 'GET'));
      if (method === null) {
        throw new Error(`invalid http client config: wrapper method must be a concrete verb at ${at}`);
      }
      const parameter = typeof record['parameter'] === 'string' ? record['parameter'] : undefined;
      return {
        name: String(record['name']),
        method,
        ...(methodFromBody ? { methodFromBody: true } : {}),
        ...(parameter === undefined ? {} : { parameter }),
        ...parseEntryScoping(record, 'wrapperFunctions', at),
      };
    });
  }
  if (Array.isArray(document['urlBuilders'])) {
    config.urlBuilders = document['urlBuilders'].map((entry) => {
      if (typeof entry === 'string') return { name: entry };
      const record = entry as Record<string, unknown>;
      return {
        name: String(record['name']),
        base: record['base'] === undefined ? undefined : String(record['base']),
        ...parseEntryScoping(record, 'urlBuilders', at),
      };
    });
  }
  if (Array.isArray(document['sameOriginHosts'])) {
    config.sameOriginHosts = document['sameOriginHosts'].map((host) => String(host));
  }
  return config;
}
