/**
 * Webhook detector (pack-webhook).
 *
 * Pure TypeScript scan (no subprocess, no Python): walks `.ts`, `.tsx`,
 * `.js`, `.mjs` files and detects webhook endpoint patterns across
 * four surfaces:
 *
 *   1. Express — `app.post(...)` or `router.post(...)` whose first
 *      argument's path literal contains a webhook-y segment: `webhook`,
 *      `hook`, or `callback` (case-insensitive, dynamic `:id` segments
 *      allowed).
 *   2. Fastify — same shape; the webhook path marker lives in the
 *      FIRST string-literal argument of `fastify.METHOD(...)`.
 *   3. Hono — same shape; the webhook path marker lives in the
 *      FIRST string-literal argument of `app.METHOD(...)` from a file
 *      that imports `hono` (the receiver name `app` is otherwise
 *      identical to Express; we disambiguate by import context).
 *   4. Decorator-based — `@webhook('stripe.payments')` or
 *      `@on('webhook.stripe.payments')` on a controller method.
 *
 * Each detected endpoint becomes a `webhook.endpoint` resource:
 *   {
 *     id: "webhook.<provider>.<endpoint>",
 *     kind: "webhook.endpoint",
 *     attributes: {
 *       signatureHeader: string,
 *       signatureAlgorithm: 'hmac-sha256' | 'hmac-sha1' | 'none',
 *       replayWindow: number (ms, default 300_000),
 *       maxBody: number (bytes),
 *       framework: 'express' | 'fastify' | 'hono' | 'decorator',
 *       path: string,
 *       httpMethods: string[],
 *       provider: string,
 *     }
 *   }
 *
 * Findings emitted:
 *   - `DUPLICATE_RESOURCE_ID` — same id derived twice (fail-closed).
 *   - `PARSE_ERROR` — GF-19-style fallback when the scanner cannot
 *     read a file.
 *
 * Determinism: stable sort + derived ids only; no `Date.now()`, no
 * `Math.random()`. Resource ids encode provider + endpoint token so
 * multiple webhooks in one file never collide.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, relative, resolve } from 'node:path';
import { GATEFORGE_SCHEMA_VERSION } from '@gate-forge/core';
import type { DiscoveryOutcome, Finding } from '@gate-forge/plugin-protocol';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';

/** Detected framework of a webhook endpoint. */
export type WebhookFramework = 'express' | 'fastify' | 'hono' | 'decorator';

/** Allowed signature algorithms the detector records. */
export type SignatureAlgorithm = 'hmac-sha256' | 'hmac-sha1' | 'none';

/** The detector's resource-attribute payload (deterministic, JSON-safe). */
export interface WebhookResourceAttributes {
  /** Framework the resource was detected in. */
  framework: WebhookFramework;
  /** Stable path the endpoint is mounted at. */
  path: string;
  /** HTTP methods the route accepts (sorted). */
  httpMethods: string[];
  /** HTTP header the signature is read from (default `x-signature`). */
  signatureHeader: string;
  /** HMAC variant the signature uses (`none` if no signature detected). */
  signatureAlgorithm: SignatureAlgorithm;
  /** Anti-replay window in milliseconds (default 300000 = 5 minutes). */
  replayWindow: number;
  /** Maximum accepted body size in bytes (default 1 MiB). */
  maxBody: number;
  /** Provider token extracted from the path or decorator argument. */
  provider: string;
}

/** Internal: one detected webhook endpoint before id resolution. */
interface DetectedWebhook {
  framework: WebhookFramework;
  path: string;
  httpMethods: string[];
  provider: string;
  signatureHeader: string;
  signatureAlgorithm: SignatureAlgorithm;
  replayWindow: number;
  maxBody: number;
  sourceFile: string;
  sourceLine: number;
  sourceCol: number;
}

/** Detector options. */
export interface WebhookDetectorOptions {
  /** Repo-root directory used to compute repo-relative paths. */
  root?: string;
  /** Default replay window override (ms). Defaults to 300000. */
  defaultReplayWindow?: number;
  /** Default max body override (bytes). Defaults to 1_048_576 (1 MiB). */
  defaultMaxBody?: number;
}

/** The pinned in-process plugin contract. */
export interface WebhookDetector {
  discover(paths: readonly string[]): DiscoveryOutcome;
}

/** Default replay window if not otherwise configured: 5 minutes. */
const DEFAULT_REPLAY_WINDOW_MS = 300_000;

/** Default body cap if not otherwise configured: 1 MiB. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Default signature header if not otherwise configured. */
const DEFAULT_SIGNATURE_HEADER = 'x-signature';

/** Token regex used to detect webhook paths. */
const WEBHOOK_TOKEN = /webhook|hook|callback/i;

/** Skip list for the file walker. */
const SKIP_DIRS: Record<string, true> = { 'node_modules': true, 'dist': true, '.git': true };

/** Walks `paths` collecting every `.ts`/`.tsx`/`.js`/`.mjs` file. */
function collectFiles(paths: readonly string[]): string[] {
  const out = new Set<string>();
  const visit = (abs: string): void => {
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (stat.isFile()) {
      const ext = extname(abs);
      if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.mjs') {
        out.add(abs);
      }
      return;
    }
    if (stat.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP_DIRS[entry.name] === true) continue;
        visit(join(abs, entry.name));
      }
    }
  };
  for (const p of paths) visit(resolve(p));
  return [...out].sort();
}

/** Convert an absolute file path into a forward-slash, repo-relative path. */
function toRepoRelative(root: string, absFile: string): string {
  const rel = relative(root, absFile).replace(/\\/g, '/');
  return rel.startsWith('/') ? rel.slice(1) : rel;
}

/**
 * Extract the provider token from a webhook path. Returns the first
 * remaining segment after stripping the webhook marker tokens
 * (`webhook`, `hook`, `callback`), lowercased and slug-ified.
 */
function providerFromPath(path: string): string {
  const cleaned = path.replace(/^\/+|\/+$/g, '');
  const segments = cleaned.split('/').filter((s) => s.length > 0 && !s.startsWith(':') && !s.startsWith('{'));
  const remaining = segments.filter((s) => !WEBHOOK_TOKEN.test(s));
  const provider = remaining.length > 0 ? (remaining[0] ?? 'default') : (segments[0] ?? 'default');
  return provider.replace(/[^a-zA-Z0-9.]+/g, '-').toLowerCase();
}

/** Heuristic algorithm inference from a path / config string. */
function inferAlgorithm(hint: string | undefined): SignatureAlgorithm {
  if (!hint) return 'hmac-sha256';
  const lower = hint.toLowerCase();
  if (lower.includes('sha1')) return 'hmac-sha1';
  if (lower.includes('sha256')) return 'hmac-sha256';
  if (lower.includes('none') || lower.includes('unsigned')) return 'none';
  return 'hmac-sha256';
}

/** Signature-header inference from adjacent text. */
function inferSignatureHeader(text: string): string {
  const patterns: RegExp[] = [
    /signatureHeader\s*[:=]\s*['"]([^'"]+)['"]/,
    /signature\s*[:=]\s*['"]([^'"]+)['"]/,
    /headers\s*\[\s*['"]([^'"]+)['"]\s*\]/,
    /req\.header\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return DEFAULT_SIGNATURE_HEADER;
}

/** Locate the line+col of `index` in `text`. */
function lineColOf(text: string, index: number): { line: number; col: number } {
  const pre = text.slice(0, index);
  const line = pre.split('\n').length;
  const lastNewline = pre.lastIndexOf('\n');
  const col = lastNewline < 0 ? index : index - lastNewline - 1;
  return { line, col: Math.max(0, col) };
}

/** True when the file imports `hono`. Used to disambiguate `app.METHOD(...)`. */
function isHonoContext(text: string): boolean {
  return /from\s+['"]hono['"]|require\s*\(\s*['"]hono['"]\s*\)/.test(text);
}

/** Map a route-registration receiver name to its framework. */
function frameworkOfReceiver(receiver: string, fileText: string): WebhookFramework {
  if (receiver === 'fastify') return 'fastify';
  if (receiver === 'hono') return 'hono';
  if (receiver === 'app' && isHonoContext(fileText)) return 'hono';
  return 'express';
}

/** Build the standard `webhook.endpoint` shape for one detected endpoint. */
function buildResource(d: DetectedWebhook, id: string, file: string): DiscoveryOutcome['resources'][number] {
  const attributes: Record<string, unknown> = {
    framework: d.framework,
    path: d.path,
    httpMethods: [...d.httpMethods].sort(),
    signatureHeader: d.signatureHeader,
    signatureAlgorithm: d.signatureAlgorithm,
    replayWindow: d.replayWindow,
    maxBody: d.maxBody,
    provider: d.provider,
  };
  return {
    schemaVersion: GATEFORGE_SCHEMA_VERSION,
    id,
    kind: 'webhook.endpoint',
    source: file,
    location: { file, line: d.sourceLine, col: d.sourceCol },
    detectorVersion: PACK_VERSION,
    attributes,
  };
}

/** Build a `Finding` with one location. */
function finding(code: string, detail: string, file: string, line: number, col: number): Finding {
  return {
    code,
    detail,
    locations: [{ file, line, col }],
  };
}

/** Scan for route registrations whose FIRST string-literal path is webhook-shaped. */
function scanRouteRegistries(
  text: string,
  file: string,
  options: Required<Pick<WebhookDetectorOptions, 'defaultReplayWindow' | 'defaultMaxBody'>>,
): DetectedWebhook[] {
  const out: DetectedWebhook[] = [];
  const re = /(app|router|fastify|hono)\.(get|post|put|patch|delete|all)\s*\(\s*['"]([^'"]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const receiver = (m[1] ?? '').toLowerCase();
    const method = (m[2] ?? '').toUpperCase();
    const path = m[3] ?? '';
    if (!WEBHOOK_TOKEN.test(path)) continue;
    const tailStart = m.index;
    const tailEnd = Math.min(text.length, tailStart + 800);
    const tail = text.slice(tailStart, tailEnd);
    const signatureHeader = inferSignatureHeader(tail);
    const algorithm = inferAlgorithm(tail);
    const framework = frameworkOfReceiver(receiver, text);
    const { line, col } = lineColOf(text, m.index);
    out.push({
      framework,
      path,
      httpMethods: [method],
      provider: providerFromPath(path),
      signatureHeader,
      signatureAlgorithm: algorithm,
      replayWindow: options.defaultReplayWindow,
      maxBody: options.defaultMaxBody,
      sourceFile: file,
      sourceLine: line,
      sourceCol: col,
    });
  }
  return out;
}

/** Scan for `@webhook(...)` / `@on('webhook.x')` decorator-shaped endpoints. */
function scanDecorators(
  text: string,
  file: string,
  options: Required<Pick<WebhookDetectorOptions, 'defaultReplayWindow' | 'defaultMaxBody'>>,
): DetectedWebhook[] {
  const out: DetectedWebhook[] = [];
  const re = /@(webhook|on)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const decoratorName = (m[1] ?? '').toLowerCase();
    const literal = m[2] ?? '';
    if (decoratorName === 'on' && !/^webhook[.:]/i.test(literal)) continue;
    const providerRaw = literal.replace(/^webhook[.:]+/i, '');
    const provider = providerRaw.replace(/[^a-zA-Z0-9.]+/g, '-').toLowerCase();
    const tailStart = m.index;
    const tailEnd = Math.min(text.length, tailStart + 600);
    const tail = text.slice(tailStart, tailEnd);
    const httpMatch = tail.match(/@(Get|Post|Put|Patch|Delete|All)\s*\(\s*['"]([^'"]+)['"]/i);
    const method = httpMatch ? (httpMatch[1] ?? 'POST').toUpperCase() : 'POST';
    const path = httpMatch ? (httpMatch[2] ?? '/webhook') : '/webhook';
    const signatureHeader = inferSignatureHeader(tail);
    const algorithm = inferAlgorithm(tail);
    const { line, col } = lineColOf(text, m.index);
    out.push({
      framework: 'decorator',
      path,
      httpMethods: [method],
      provider: provider === '' ? 'default' : provider,
      signatureHeader,
      signatureAlgorithm: algorithm,
      replayWindow: options.defaultReplayWindow,
      maxBody: options.defaultMaxBody,
      sourceFile: file,
      sourceLine: line,
      sourceCol: col,
    });
  }
  return out;
}

/** Build a stable resource id from a detected webhook. */
function webhookId(d: DetectedWebhook): string {
  const cleaned = d.path.replace(/^\/+|\/+$/g, '');
  const segments = cleaned.split('/').filter((s) => s.length > 0 && !s.startsWith(':') && !s.startsWith('{'));
  const endpoint = segments.length > 0 ? (segments[segments.length - 1] ?? 'default') : 'default';
  const provider = d.provider === '' ? 'default' : d.provider;
  const safeEndpoint = endpoint.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() || 'default';
  return `webhook.${provider}.${safeEndpoint}`;
}

/** The default exports for the pack: `discover(paths)`. */
export function discoverWebhooks(paths: readonly string[], options: WebhookDetectorOptions = {}): DiscoveryOutcome {
  const root = options.root ?? process.cwd();
  const files = collectFiles(paths);
  const opt: Required<Pick<WebhookDetectorOptions, 'defaultReplayWindow' | 'defaultMaxBody'>> = {
    defaultReplayWindow: options.defaultReplayWindow ?? DEFAULT_REPLAY_WINDOW_MS,
    defaultMaxBody: options.defaultMaxBody ?? DEFAULT_MAX_BODY_BYTES,
  };

  const detected: DetectedWebhook[] = [];
  const findings: Finding[] = [];

  const scanned: string[] = [];
  for (const abs of files) {
    const file = toRepoRelative(root, abs);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      findings.push(finding('PARSE_ERROR', `unable to read ${file}`, file, 1, 0));
      continue;
    }
    scanned.push(file);
    detected.push(...scanRouteRegistries(text, file, opt), ...scanDecorators(text, file, opt));
  }

  // Build resources with deterministic ids; flag duplicates.
  const seen = new Map<string, string>();
  const resources: DiscoveryOutcome['resources'] = [];
  for (const d of detected) {
    const id = webhookId(d);
    const existing = seen.get(id);
    if (existing !== undefined) {
      findings.push(finding(
        'DUPLICATE_RESOURCE_ID',
        `duplicate webhook id ${id} (also at ${existing})`,
        d.sourceFile,
        d.sourceLine,
        d.sourceCol,
      ));
      continue;
    }
    seen.set(id, d.sourceFile);
    resources.push(buildResource(d, id, d.sourceFile));
  }

  resources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  findings.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.detail !== b.detail) return a.detail < b.detail ? -1 : 1;
    return 0;
  });

  // Phase-4 linkage (plan phase 4, ADR 0003 D1/D2): a webhook endpoint is
  // externally reachable by definition — one code-positive `exposure`
  // signal per endpoint, targeted at the path-derived resource name so
  // the core classifier can converge it with a discovered table. An
  // underivable name emits no signal (nothing is claimed). No lifecycle
  // or negative claims exist in this pack: receiving events proves
  // reachability, nothing more.
  const classificationSignals = resources.flatMap((resource) => {
    const attributes = resource.attributes as unknown as WebhookResourceAttributes;
    const target = lastPathName(attributes.path);
    if (target === null) return [];
    return [{
      schemaVersion: 1 as const,
      target: { resourceName: target },
      dimension: 'exposure' as const,
      assertion: 'webhook',
      basis: 'code-positive' as const,
      source: PACK_PLUGIN_ID,
      location: resource.location,
      detector: { id: PACK_PLUGIN_ID, version: PACK_VERSION },
    }];
  });
  return { resources, unresolved: [], findings, classificationSignals, scannedPaths: scanned.sort() };
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

/** Build a discover-capable detector module. */
export function createWebhookDetector(options: WebhookDetectorOptions = {}): WebhookDetector {
  return {
    discover(paths: readonly string[]): DiscoveryOutcome {
      return discoverWebhooks(paths, options);
    },
  };
}