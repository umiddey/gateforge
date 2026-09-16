/**
 * Auth pack detector — discovers role-guard + tenant-isolation patterns
 * in TypeScript / JavaScript HTTP route definitions and emits one
 * `auth.resource` per guarded endpoint.
 *
 * Recognised constructs (TS/JS only; FastAPI/Python deferred — see the
 * pack README "Limitations"):
 *
 *   - NestJS: `@UseGuards(RolesGuard)`, `@Roles('admin', 'manager')`,
 *     plus the controller / method declaration that hosts them
 *     (`@Controller('billing')`, `@Post('refund')`).
 *   - Express middleware chains: `app.post('/billing/refund',
 *     requireRole('admin'), requireTenant(), handler)`.
 *   - Fastify preHandler hooks: `fastify.post('/billing/refund',
 *     { preHandler: [requireRole('admin'), requireTenant()] }, handler)`.
 *   - Hono middleware: `app.post('/billing/refund',
 *     requireRole('admin'), requireTenant(), (c) => c.json(...))`.
 *
 * Discovery outcome:
 *
 *   - One `auth.resource` per guarded endpoint, id = `auth.<METHOD>.<path>`
 *     (lower-cased, slashes -> dots, segments stripped). Deterministic.
 *   - `attributes.roleRequirement`: `string[]` of role names the guard
 *     accepts; `[]` when no role guard (tenancy may still be present).
 *   - `attributes.tenancy`: `'tenant-bound' | 'none'`. `'tenant-bound'`
 *     when a tenant check is detected (e.g. `requireTenant()` middleware,
 *     `req.user.tenantId === target.tenantId`, `tenantId` in route).
 *   - `attributes.framework`: `'nestjs' | 'express' | 'fastify' | 'hono'`.
 *   - `attributes.method`: HTTP method upper-cased.
 *   - `attributes.path`: Normalised route path.
 *   - `findings[]`: ALWAYS empty in this pack — the detector fails
 *     CLOSED by omitting findings for unparseable constructs; the
 *     graph emits the typed `unresolved` entry for partial patterns.
 *
 * Determinism: regex/parse-tree scan is pure over (paths, file bytes);
 * no `Date.now()`, no `Math.random()`. Output is sorted by id.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import type { z } from 'zod';
import { LocationSchema, type Resource } from '@gate-forge/core';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';

/** Inferred location shape (file, 1-based line, 0-based col). */
type Location = z.infer<typeof LocationSchema>;

/** Detector contract: `discover(paths)` is sync (pure over file bytes). */
export interface AuthDetector {
  discover(paths: readonly string[]): DiscoveryOutcome;
}

/** Options for {@link createAuthDetector}. */
export interface AuthDetectorOptions {
  /** Repo root for repo-relative `source` paths (default: `process.cwd()`). */
  root?: string;
}

/** Detected framework for a resource. */
export type AuthFramework = 'nestjs' | 'express' | 'fastify' | 'hono';

/** Tenancy classification for one endpoint. */
export type Tenancy = 'tenant-bound' | 'none';

/** One discovered guarded endpoint. */
interface Endpoint {
  method: string;
  path: string;
  framework: AuthFramework;
  roles: string[];
  tenancy: Tenancy;
  file: string;
  line: number;
  col: number;
}

/**
 * Directories the detector skips by name (purely the noisy parts of any
 * repo): never feed them to `readFileSync` even if the caller forgot to
 * exclude them.
 */
const SKIP_DIR_NAMES: Record<string, true> = {
  node_modules: true,
  dist: true,
  build: true,
  coverage: true,
  '.git': true,
  '.next': true,
  '.turbo': true,
  '.cache': true,
  out: true,
  __pycache__: true,
};

/**
 * Looks for `requireRole('admin', 'manager')` / `requireRole(['admin'])`
 * calls inside a middleware argument list. Returns `null` when no
 * role middleware is detectable (caller treats as "no role requirement"
 * unless tenancy is also present).
 */
function extractRolesFromMiddlewareArgs(args: string): string[] | null {
  const roles = new Set<string>();
  let sawAny = false;
  const direct = /\brequire(?:Role|Roles)\(\s*(['"])([^'"]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = direct.exec(args)) !== null) {
    sawAny = true;
    roles.add(match[2] ?? '');
  }
  const array = /\brequire(?:Role|Roles)\(\s*\[([^\]]+)\]/g;
  while ((match = array.exec(args)) !== null) {
    sawAny = true;
    const inner = match[1] ?? '';
    const literal = /(['"])([^'"]+)\1/g;
    let m2: RegExpExecArray | null;
    while ((m2 = literal.exec(inner)) !== null) {
      roles.add(m2[2] ?? '');
    }
  }
  if (!sawAny) return null;
  return [...roles].sort();
}

/** Tenant check by middleware name (Express/Fastify/Hono shared). */
const TENANT_MW = /\b(requireTenant|requireTenantScope|tenantGuard|ensureTenant|withTenant)\b/;

/** `req.user.tenantId` / `tenantId === ...` / `:tenantId` path param. */
const TENANT_LITERAL = /\btenantId\b/;

/**
 * Reads the balanced argument list starting at `start`. Returns the
 * text between `(` and its matching `)` at depth 0, or `null` if the
 * parens are unbalanced (defensive: caller treats as "unscannable").
 */
function readBalancedArgs(text: string, start: number): string | null {
  let i = start;
  while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
  if (text[i] !== '(') return null;
  i += 1;
  let depth = 1;
  let inStr: '"' | "'" | '`' | null = null;
  const startIdx = i;
  while (i < text.length && depth > 0) {
    const ch = text[i] ?? '';
    if (inStr !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth === 0) {
      return text.slice(startIdx, i);
    }
    i += 1;
  }
  return null;
}

/** Joins controller prefix + method sub-path; strips trailing slash. */
function joinPath(prefix: string, suffix: string): string {
  if (prefix === '' && suffix === '') return '/';
  if (prefix === '') return normalisePath(suffix);
  if (suffix === '') return normalisePath(prefix);
  return normalisePath(`${prefix}/${suffix}`);
}

/** Normalises a route path: ensures leading '/', collapses '//'. */
function normalisePath(p: string): string {
  let s = p;
  if (!s.startsWith('/')) s = `/${s}`;
  while (s.includes('//')) s = s.replace(/\/\//g, '/');
  return s;
}

/**
 * Builds the stable resource id from a normalised path. Slashes become
 * dots; `:` (path params) become the literal string `colon`; non-identifier
 * characters are dropped. Example: `POST /billing/refund` -> `auth.post.billing.refund`.
 */
function buildResourceId(method: string, path: string): string {
  const normalised = path.replace(/^\//, '').replace(/\/$/, '');
  if (normalised === '') return `auth.${method.toLowerCase()}.root`;
  const segments = normalised.split('/').map((s) => s.replace(/:/g, 'colon').replace(/[^A-Za-z0-9_.-]/g, ''));
  return `auth.${method.toLowerCase()}.${segments.join('.')}`;
}

/** Returns the 1-based line number that contains `offset`. */
function lineNumberFor(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** Returns the 0-based column of `offset` (chars since the last '\n'). */
function columnFor(text: string, offset: number): number {
  let col = 0;
  for (let i = offset - 1; i >= 0; i -= 1) {
    if (text[i] === '\n') break;
    col += 1;
  }
  return col;
}

/**
 * Walks a directory tree, returning all `.ts`/`.tsx`/`.js`/`.mjs` files
 * (skipping excluded directories by name). Deterministic order (sorted).
 */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: { name: string; isFile: boolean }[];
    try {
      entries = readdirSync(current, { withFileTypes: true }).map((d) => ({
        name: d.name,
        isFile: d.isFile(),
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = `${current}${sep}${entry.name}`;
      if (!entry.isFile) {
        if (SKIP_DIR_NAMES[entry.name] === true) continue;
        stack.push(full);
        continue;
      }
      if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
    }
  }
  out.sort();
  return out;
}

/**
 * Coerces a caller path into the absolute file the detector reads. If
 * `path` is a directory, it is walked recursively. Otherwise the file is
 * read directly (must end in a recognised extension).
 */
function resolveInputs(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const input of paths) {
    const abs = resolve(input);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const f of walkFiles(abs)) out.push(f);
    } else if (/\.(ts|tsx|js|mjs)$/.test(abs)) {
      out.push(abs);
    }
  }
  out.sort();
  return out;
}

/**
 * Pulls a list of string literals out of an `@Roles(...)` argument list.
 * Accepts `'admin', "manager"` (single + double). Returns null when the
 * argument list cannot be parsed (caller treats as "no role
 * requirement detected" rather than throwing).
 */
function extractRoleLiterals(args: string): string[] | null {
  const out: string[] = [];
  const re = /(['"])([^'"]+)\1/g;
  let match: RegExpExecArray | null;
  let sawAny = false;
  while ((match = re.exec(args)) !== null) {
    sawAny = true;
    out.push(match[2] ?? '');
  }
  if (!sawAny) return null;
  return out;
}

/**
 * Scans one file's text for NestJS class-level controller decorators
 * followed by method-level decorators within the class body, building
 * the `<METHOD> <PATH>` declaration pair. We look for `@UseGuards(RolesGuard)`
 * or `@Roles(...)` anywhere inside the class body, then emit one
 * resource per guarded method. Unguarded controllers produce nothing.
 */
function scanNest(text: string, file: string): Endpoint[] {
  const out: Endpoint[] = [];
  const controllerRe = /@Controller\(\s*(['"])([^'"]+)\1\s*\)/g;
  let controller: RegExpExecArray | null;
  while ((controller = controllerRe.exec(text)) !== null) {
    const classPath = (controller[2] ?? '').trim();
    const classStart = controller.index + controller[0].length;
    // Find the next class body closing brace at depth 0 (best-effort).
    let depth = 0;
    let classEnd = text.length;
    for (let i = classStart; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          classEnd = i;
          break;
        }
      }
    }
    const classBody = text.slice(classStart, classEnd);
    const hasGuard = /@(?:UseGuards)\(\s*RolesGuard\s*\)/.test(classBody);
    const rolesMatch = /@(?:Roles)\(\s*([^)]+)\)/.exec(classBody);
    const roles = rolesMatch ? extractRoleLiterals(rolesMatch[1] ?? '') : null;
    if (!hasGuard && roles === null) continue;
    const declaredRoles = roles ?? [];
    const nestMethod = /@(Get|Post|Put|Patch|Delete|All)\(\s*(['"])([^'"]*)\2\s*\)/g;
    nestMethod.lastIndex = 0;
    let method: RegExpExecArray | null;
    while ((method = nestMethod.exec(classBody)) !== null) {
      const verb = (method[1] ?? '').toUpperCase();
      const subPathRaw = method[3] ?? '';
      const subPath = subPathRaw.trim();
      const path = joinPath(classPath, subPath);
      const offset = method.index + classStart;
      out.push({
        method: verb,
        path,
        framework: 'nestjs',
        roles: declaredRoles,
        tenancy: TENANT_LITERAL.test(classBody) ? 'tenant-bound' : 'none',
        file,
        line: lineNumberFor(text, offset),
        col: columnFor(text, offset),
      });
    }
  }
  return out;
}

/**
 * Scans Express middleware chain routes. The roles + tenancy come from
 * the middleware names AFTER the path string and BEFORE the handler
 * (final function). We do NOT trust arbitrary strings; we only inspect
 * middleware identifiers.
 */
function scanExpress(text: string, file: string): Endpoint[] {
  const out: Endpoint[] = [];
  const route = /\b(app|router)\.(get|post|put|patch|delete|all)\(\s*(['"])([^'"]+)\3/g;
  route.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = route.exec(text)) !== null) {
    const verb = (m[2] ?? '').toUpperCase();
    const routePath = (m[4] ?? '').trim();
    // Find the `(` ourselves (the regex consumed `path` already, so m[0]
    // ends at the closing quote of the path string, not at the `(`).
    const parenIdx = text.indexOf('(', m.index);
    if (parenIdx < 0) continue;
    const callArgs = readBalancedArgs(text, parenIdx);
    if (callArgs === null) continue;
    const roles = extractRolesFromMiddlewareArgs(callArgs);
    const tenancy = TENANT_MW.test(callArgs) || TENANT_LITERAL.test(callArgs)
      ? 'tenant-bound'
      : 'none';
    if (roles === null && tenancy === 'none') continue;
    out.push({
      method: verb,
      path: routePath,
      framework: 'express',
      roles: roles ?? [],
      tenancy,
      file,
      line: lineNumberFor(text, m.index),
      col: columnFor(text, m.index),
    });
  }
  return out;
}

/** Scans Fastify route declarations. */
function scanFastify(text: string, file: string): Endpoint[] {
  const out: Endpoint[] = [];
  const route = /\bfastify\.(get|post|put|patch|delete|all)\(\s*(['"])([^'"]+)\2/g;
  route.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = route.exec(text)) !== null) {
    const verb = (m[1] ?? '').toUpperCase();
    const routePath = (m[3] ?? '').trim();
    const parenIdx = text.indexOf('(', m.index);
    if (parenIdx < 0) continue;
    const callArgs = readBalancedArgs(text, parenIdx);
    if (callArgs === null) continue;
    const roles = extractRolesFromMiddlewareArgs(callArgs);
    const tenancy = TENANT_MW.test(callArgs) || TENANT_LITERAL.test(callArgs)
      ? 'tenant-bound'
      : 'none';
    if (roles === null && tenancy === 'none') continue;
    out.push({
      method: verb,
      path: routePath,
      framework: 'fastify',
      roles: roles ?? [],
      tenancy,
      file,
      line: lineNumberFor(text, m.index),
      col: columnFor(text, m.index),
    });
  }
  return out;
}

/** Scans Hono route declarations (Hono middleware chain). */
function scanHono(text: string, file: string): Endpoint[] {
  const out: Endpoint[] = [];
  const route = /\bapp\.(get|post|put|patch|delete|all)\(\s*(['"])([^'"]+)\2/g;
  route.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = route.exec(text)) !== null) {
    const verb = (m[1] ?? '').toUpperCase();
    const routePath = (m[3] ?? '').trim();
    const parenIdx = text.indexOf('(', m.index);
    if (parenIdx < 0) continue;
    const callArgs = readBalancedArgs(text, parenIdx);
    if (callArgs === null) continue;
    const roles = extractRolesFromMiddlewareArgs(callArgs);
    const tenancy = TENANT_MW.test(callArgs) || TENANT_LITERAL.test(callArgs)
      ? 'tenant-bound'
      : 'none';
    if (roles === null && tenancy === 'none') continue;
    out.push({
      method: verb,
      path: routePath,
      framework: 'hono',
      roles: roles ?? [],
      tenancy,
      file,
      line: lineNumberFor(text, m.index),
      col: columnFor(text, m.index),
    });
  }
  return out;
}

/**
 * Scans one file's text and returns every endpoint discovered across all
 * supported frameworks. The detector NEVER throws; an unreadable file
 * produces an empty list (fail-closed).
 */
function scanFile(text: string, file: string): Endpoint[] {
  const out: Endpoint[] = [];
  for (const ep of scanNest(text, file)) out.push(ep);
  // For Express/Fastify/Hono, only run the scanner whose import the
  // file uses. `app.post` is the same shape across all three; without
  // import-based disambiguation the first scanner to run wins and
  // wrong-attribution leaks across frameworks.
  if (/\bfrom\s+['"]hono['"]/.test(text) || /\brequire\(\s*['"]hono['"]/.test(text)) {
    for (const ep of scanHono(text, file)) out.push(ep);
  } else if (/\bfrom\s+['"]fastify['"]/.test(text) || /\brequire\(\s*['"]fastify['"]/.test(text)) {
    for (const ep of scanFastify(text, file)) out.push(ep);
  } else {
    for (const ep of scanExpress(text, file)) out.push(ep);
  }
  return out;
}

/**
 * Builds one `auth.resource` from one detected endpoint. The output
 * shape is the frozen GPP/3 `Resource` schema (id, kind, source,
 * location, detectorVersion, attributes).
 */
function endpointToResource(root: string, ep: Endpoint): Resource {
  const id = buildResourceId(ep.method, ep.path);
  const sourceRel = relative(root, ep.file).split(sep).join('/');
  const location: Location = { file: sourceRel, line: ep.line, col: ep.col };
  return {
    schemaVersion: 1,
    id,
    kind: 'auth.resource',
    source: sourceRel,
    location,
    detectorVersion: PACK_VERSION,
    attributes: {
      method: ep.method,
      path: ep.path,
      framework: ep.framework,
      roleRequirement: ep.roles,
      tenancy: ep.tenancy,
    },
  };
}

/**
 * Creates the discover-capable detector module. The default export of
 * the pack is `createAuthDetector()` — the CLI in-process contract.
 *
 * Args:
 *   options: Optional root override for repo-relative `source` paths.
 *
 * Returns:
 *   AuthDetector: the pinned `{ discover(paths) }` module.
 */
export function createAuthDetector(options: AuthDetectorOptions = {}): AuthDetector {
  const root = options.root ?? process.cwd();
  return {
    discover(paths) {
      if (paths.length === 0) {
        return { resources: [], unresolved: [], findings: [], classificationSignals: [] };
      }
      const files = resolveInputs(paths);
      const endpoints: Endpoint[] = [];
      const scanned: string[] = [];
      const findings: DiscoveryOutcome['findings'] = [];
      for (const file of files) {
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch (error) {
          // Fail-visible coverage (ADR 0003 D4): an unreadable file is a
          // finding, never a silent hole in the scan.
          findings.push({
            code: 'SOURCE_READ_ERROR',
            detail: `failed to read '${relative(root, file).split(sep).join('/')}': ${error instanceof Error ? error.message : String(error)}`,
            locations: [{ file: relative(root, file).split(sep).join('/'), line: 1, col: 0 }],
          });
          continue;
        }
        scanned.push(relative(root, file).split(sep).join('/'));
        for (const endpoint of scanFile(text, file)) endpoints.push(endpoint);
      }
      endpoints.sort((a, b) => {
        const idA = buildResourceId(a.method, a.path);
        const idB = buildResourceId(b.method, b.path);
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      });
      const resources = endpoints.map((ep) => endpointToResource(root, ep));
      // Phase-4 linkage (plan phase 4, ADR 0003 D1/D2): each guarded
      // endpoint is externally reachable — one code-positive `exposure`
      // signal per endpoint plus `lifecycle.<op>` from the HTTP method
      // (POST⇒create, GET/HEAD⇒read, PUT/PATCH⇒update, DELETE⇒delete),
      // and a `plane` signal asserting `tenant` when a tenant guard is
      // present. Targets are the PATH-DERIVED resource name (last
      // non-parameter segment) so the core classifier converges routes
      // with tables deterministically; an underivable name emits no
      // signal (nothing is claimed). `app.all`-style methods assert no
      // operation. No negative proofs exist in this pack.
      const classificationSignals = endpoints.flatMap((ep) => {
        const location: Location = {
          file: relative(root, ep.file).split(sep).join('/'),
          line: ep.line,
          col: ep.col,
        };
        const target = lastPathName(ep.path);
        if (target === null) return [];
        const signals: DiscoveryOutcome['classificationSignals'] = [
          {
            schemaVersion: 1,
            target: { resourceName: target },
            dimension: 'exposure',
            assertion: 'route',
            basis: 'code-positive',
            source: PACK_PLUGIN_ID,
            location,
            detector: { id: PACK_PLUGIN_ID, version: PACK_VERSION },
          },
        ];
        const operation = operationForMethod(ep.method);
        if (operation !== null) {
          signals.push({
            schemaVersion: 1,
            target: { resourceName: target },
            dimension: `lifecycle.${operation}`,
            assertion: true,
            basis: 'code-positive',
            source: PACK_PLUGIN_ID,
            location,
            detector: { id: PACK_PLUGIN_ID, version: PACK_VERSION },
          });
        }
        if (ep.tenancy === 'tenant-bound') {
          signals.push({
            schemaVersion: 1,
            target: { resourceName: target },
            dimension: 'plane',
            assertion: 'tenant',
            basis: 'code-positive',
            source: PACK_PLUGIN_ID,
            location,
            detector: { id: PACK_PLUGIN_ID, version: PACK_VERSION },
          });
        }
        return signals;
      });
      findings.sort((a, b) => (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
      return { resources, unresolved: [], findings, classificationSignals, scannedPaths: scanned.sort() };
    },
  };
}
/** The lifecycle operation an HTTP method evidences, if any. */
function operationForMethod(
  method: string,
): 'create' | 'read' | 'update' | 'delete' | null {
  switch (method) {
    case 'POST': return 'create';
    case 'GET':
    case 'HEAD': return 'read';
    case 'PUT':
    case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return null;
  }
}

/** Last non-parameter path segment, lower-cased; null when underivable. */
function lastPathName(rawPath: string): string | null {
  const segments = rawPath.split('/').filter((segment) => segment.length > 0);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment === undefined) continue;
    if (segment.startsWith(':') || segment.startsWith('{') || segment.startsWith('*')) continue;
    if (/^\d+$/.test(segment)) continue;
    return segment.toLowerCase();
  }
  return null;
}
