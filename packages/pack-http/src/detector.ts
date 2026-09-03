/**
 * Generic HTTP exposure pack detector (plan phase 4, ADR 0003 D1/D2).
 *
 * Discovers externally-reachable HTTP artifacts in TypeScript/JavaScript
 * sources and emits classification signals ONLY — routes are EVIDENCE,
 * never business resources (red-team round 2): a route resource carrying
 * the path-derived bare name would collide with the converged table at
 * the same plane-qualified id (DUPLICATE_BOUND_RESOURCE_ID). The
 * artifact's identity lives in its signals' locations:
 *
 *   - Server routes: Express `app.get('/path', …)` / `router.post(…)`,
 *     Fastify and Hono registrations (import-disambiguated, mirroring
 *     pack-auth's convention), and NestJS `@Controller('prefix')` +
 *     `@Get('suffix')` decorators.
 *   - Frontend API-client calls: `fetch('/api/accounts')` /
 *     `axios.get('/api/accounts')` with literal URL paths — the
 *     frontend-only exposure path (checklist: frontend-only linkage
 *     marks a resource user-facing).
 *
 * Signals (facts, never classifications):
 *   - `exposure` code-positive per discovered artifact (assertion
 *     `route` for server routes, `frontend-call` for API-client calls),
 *     targeted at the PATH-DERIVED resource name (last non-parameter
 *     path segment, lower-cased). The classifier converges route and
 *     table by that name; when no resource with the name exists the
 *     signal surfaces as a typed STALE_SIGNAL_TARGET block — a link the
 *     engine could not resolve blocks rather than guesses.
 *   - `lifecycle.<op>` code-positive from the HTTP method
 *     (POST⇒create, GET/HEAD⇒read, PUT/PATCH⇒update, DELETE⇒delete);
 *     `app.all` asserts nothing.
 *   - A route whose resource name is underivable (`/`, all-parameter)
 *     emits NO signal — nothing is claimed about an unnamed target.
 *
 * No negative proof exists anywhere in this pack (plan §4.3: no
 * regex-only negative proof, no "not found means internal"); it never
 * writes classifications, only evidence.
 *
 * Determinism: pure over (paths, file bytes); no clock, no network;
 * output sorted by resource id; signals sorted by canonical JSON.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
import type { z } from 'zod';
import { LocationSchema, type ClassificationSignal } from '@gateforge/core';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';

/** Inferred location shape (file, 1-based line, 0-based col). */
type Location = z.infer<typeof LocationSchema>;

/** Detector contract: `discover(paths)` is sync (pure over file bytes). */
export interface HttpDetector {
  discover(paths: readonly string[]): DiscoveryOutcome;
}

/** Options for {@link createHttpDetector}. */
export interface HttpDetectorOptions {
  /** Repo root for repo-relative `source` paths (default: `process.cwd()`). */
  root?: string;
}

/** Where an externally-reachable artifact was found. */
export type HttpOrigin = 'express' | 'fastify' | 'hono' | 'nestjs' | 'fetch' | 'axios';

/** One discovered HTTP artifact before resource/signal construction. */
interface HttpArtifact {
  /** HTTP method, upper-cased (`''` for method-less client calls). */
  method: string;
  /** Literal route/URL path as written. */
  path: string;
  origin: HttpOrigin;
  file: string;
  line: number;
  col: number;
}

/** Directories the detector never descends into. */
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

/** Scanned source extensions. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Recursively resolves repo-relative input paths to source files. */
function resolveInputs(paths: readonly string[], root: string): string[] {
  const files: string[] = [];
  for (const rel of paths) {
    if (rel.includes('..') || resolve(root, rel) === root) continue;
    const absolute = resolve(root, rel);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(absolute);
      } catch {
        continue;
      }
      const nested = entries
        .filter((entry) => SKIP_DIR_NAMES[entry] !== true)
        .map((entry) => `${rel}/${entry}`);
      files.push(...resolveInputs(nested, root));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext))) files.push(absolute);
  }
  return files.sort();
}

/** Line/column (1-based line, 0-based col) of a text index. */
function lineColumnFor(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(index, 0));
  const lines = before.split('\n');
  return { line: lines.length, col: (lines[lines.length - 1] ?? '').length };
}

/**
 * Derives the resource name a path speaks about: the LAST non-empty,
 * non-parameter path segment, lower-cased, file extension stripped.
 * Purely-numeric segments are item selectors (`/accounts/9`), not
 * resource names, and are skipped the same as parameters. Returns
 * `null` when no such segment exists (`/`, `*`, `:id`) — the caller
 * emits NO signal rather than guessing a target.
 */
export function resourceNameFromPath(rawPath: string): string | null {
  const path = rawPath.split('?')[0]?.split('#')[0] ?? '';
  const segments = path.split('/').filter((segment) => segment.length > 0);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment === undefined) continue;
    if (segment.startsWith(':') || segment.startsWith('{') || segment.startsWith('*')) continue;
    if (/^\d+$/.test(segment)) continue;
    const cleaned = segment.replace(/\.(json|xml|txt|html)$/i, '');
    if (cleaned.length === 0) continue;
    return cleaned.toLowerCase();
  }
  return null;
}

/** The lifecycle operation an HTTP method evidences, if any. */
function operationForMethod(method: string): string | null {
  switch (method) {
    case 'POST':
      return 'create';
    case 'GET':
    case 'HEAD':
      return 'read';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return null;
  }
}

/**
 * Scans one file's text for server route registrations. Express/Fastify/
 * Hono share the `app|server|router|api.<method>( '<path>' …` shape;
 * framework attribution follows the module the file imports (pack-auth
 * convention — without import disambiguation the first scanner wins and
 * wrong attribution leaks across frameworks).
 */
function scanServerRoutes(text: string, file: string): HttpArtifact[] {
  const out: HttpArtifact[] = [];
  let origin: HttpOrigin = 'express';
  if (/\bfrom\s+['"]hono['"]/.test(text) || /\brequire\(\s*['"]hono['"]/.test(text)) {
    origin = 'hono';
  } else if (/\bfrom\s+['"]fastify['"]/.test(text) || /\brequire\(\s*['"]fastify['"]/.test(text)) {
    origin = 'fastify';
  }
  const registration = /\b(?:app|server|router|api)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/g;
  let match: RegExpExecArray | null;
  while ((match = registration.exec(text)) !== null) {
    const method = (match[1] ?? '').toUpperCase();
    const path = match[3] ?? '';
    if (path.length === 0) continue;
    const { line, col } = lineColumnFor(text, match.index);
    out.push({ method, path, origin, file, line, col });
  }
  return out;
}

/** Scans one file's text for NestJS `@Controller` + `@Get`/`@Post` pairs. */
function scanNestControllers(text: string, file: string): HttpArtifact[] {
  const out: HttpArtifact[] = [];
  const controller = /@Controller\(\s*(['"`])([^'"`]*)\1\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = controller.exec(text)) !== null) {
    const prefix = match[2] ?? '';
    // The controller body spans until the next @Controller or EOF.
    const bodyStart = match.index + (match[0]?.length ?? 0);
    const nextController = text.slice(bodyStart).search(/@Controller\(/);
    const body = text.slice(bodyStart, nextController === -1 ? undefined : bodyStart + nextController);
    const methodDecorator = /@(Get|Post|Put|Patch|Delete|All)\(\s*(['"`])?([^'"`)]*)\2?\s*\)/g;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodDecorator.exec(body)) !== null) {
      const method = (methodMatch[1] ?? '').toUpperCase();
      const suffix = methodMatch[3] ?? '';
      const path = `${prefix}/${suffix}`.replace(/\/+$/, '');
      if (path.length === 0) continue;
      const absoluteIndex = bodyStart + (methodMatch.index ?? 0);
      const { line, col } = lineColumnFor(text, absoluteIndex);
      out.push({ method, path, origin: 'nestjs', file, line, col });
    }
  }
  return out;
}

/** Scans one file's text for frontend API-client calls (fetch/axios). */
function scanClientCalls(text: string, file: string): HttpArtifact[] {
  const out: HttpArtifact[] = [];
  const fetchCall = /\bfetch\(\s*(['"`])(\/[^'"`]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = fetchCall.exec(text)) !== null) {
    const { line, col } = lineColumnFor(text, match.index);
    out.push({ method: 'GET', path: match[2] ?? '', origin: 'fetch', file, line, col });
  }
  const axiosCall = /\baxios\s*\.\s*(get|post|put|patch|delete)\(\s*(['"`])(\/[^'"`]+)\2/g;
  while ((match = axiosCall.exec(text)) !== null) {
    const method = (match[1] ?? '').toUpperCase();
    const { line, col } = lineColumnFor(text, match.index);
    out.push({ method, path: match[3] ?? '', origin: 'axios', file, line, col });
  }
  return out;
}

/** Builds the stable resource id for one artifact. */
/** One canonical classification signal (facts only). */
function signal(
  dimension: string,
  assertion: string | boolean,
  location: Location,
  targetName: string,
): ClassificationSignal {
  return {
    schemaVersion: 1,
    target: { resourceName: targetName },
    dimension: dimension as ClassificationSignal['dimension'],
    assertion,
    basis: 'code-positive',
    source: PACK_PLUGIN_ID,
    location,
    detector: { id: PACK_PLUGIN_ID, version: PACK_VERSION },
  };
}

/**
 * Creates the discover-capable detector module. The default export of
 * the pack is `createHttpDetector()` — the CLI in-process contract.
 *
 * Args:
 *   options: Optional root override for repo-relative `source` paths.
 *
 * Returns:
 *   HttpDetector: the pinned `{ discover(paths) }` module.
 */
export function createHttpDetector(options: HttpDetectorOptions = {}): HttpDetector {
  const root = options.root ?? process.cwd();
  return {
    discover(paths) {
      if (paths.length === 0) {
        return { resources: [], unresolved: [], findings: [], classificationSignals: [], scannedPaths: [] };
      }
      const files = resolveInputs(paths, root);
      const artifacts: HttpArtifact[] = [];
      const findings: Array<{ code: string; detail: string; locations: Location[] }> = [];
      const scanned: string[] = [];
      for (const file of files) {
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch (error) {
          const source = relative(root, file).split(sep).join('/');
          findings.push({
            code: 'SOURCE_READ_ERROR',
            detail: `failed to read '${source}': ${error instanceof Error ? error.message : String(error)}`,
            locations: [{ file: source, line: 1, col: 0 }],
          });
          continue;
        }
        scanned.push(relative(root, file).split(sep).join('/'));
        for (const artifact of scanServerRoutes(text, file)) artifacts.push(artifact);
        for (const artifact of scanNestControllers(text, file)) artifacts.push(artifact);
        for (const artifact of scanClientCalls(text, file)) artifacts.push(artifact);
      }
      artifacts.sort((a, b) => {
        const keyA = `${a.file}:${a.line}:${a.col}:${a.method}:${a.path}:${a.origin}`;
        const keyB = `${b.file}:${b.line}:${b.col}:${b.method}:${b.path}:${b.origin}`;
        return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
      });

      // Routes are EVIDENCE, not business resources (red-team round 2):
      // emitting a classifiable resource with the path-derived bare name
      // would collide with the converged table at the same plane-
      // qualified id. The signals below bind the exposure/lifecycle facts
      // onto the entity resource the name converges with.
      const signals: ClassificationSignal[] = [];
      for (const artifact of artifacts) {
        // Without a derived name the engine claims NOTHING about the
        // artifact's classification targets (no guess, no stale block).
        const derived = resourceNameFromPath(artifact.path);
        if (derived === null) continue;
        const sourceRel = relative(root, artifact.file).split(sep).join('/');
        const location: Location = { file: sourceRel, line: artifact.line, col: artifact.col };
        const assertion = artifact.origin === 'fetch' || artifact.origin === 'axios'
          ? 'frontend-call'
          : 'route';
        signals.push(signal('exposure', assertion, location, derived));
        const operation = operationForMethod(artifact.method);
        if (operation !== null) {
          signals.push(signal(`lifecycle.${operation}`, true, location, derived));
        }
      }

      signals.sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b)
          ? -1
          : JSON.stringify(a) > JSON.stringify(b)
            ? 1
            : 0,
      );
      findings.sort((a, b) => a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0);
      return { resources: [], unresolved: [], findings, classificationSignals: signals, scannedPaths: scanned.sort(compareStringsHttp) };
    },
  };
}

/** Codepoint sort for reported coverage paths. */
function compareStringsHttp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
