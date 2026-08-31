/**
 * The pack's discover entry: a pure TypeScript GPP/2 in-process
 * detector that scans `.ts`/`.js`/`.mjs` files for background-task
 * signatures and emits one `task.resource` per detected task plus a
 * set of typed findings (`DUPLICATE_TASK_ID`, `AMBIGUOUS_HANDLER`,
 * `PARSE_ERROR`).
 *
 * Mirrors the public shape of `packages/pack-sqlalchemy/src/detector.ts`:
 *   - `discover(paths: string[])` returns the GPP/2 `DiscoveryOutcome`
 *     shape (resources, unresolved, findings).
 *   - `createTaskDetector()` is the factory.
 *   - Resource ids are stable, dotted (`task.<name>`, e.g. `task.email.send`).
 *   - The output is deterministic (no `Date.now()` / `Math.random()`).
 *
 * Patterns detected (regex-based AST-light; matches pack-auth's strategy):
 *   - BullMQ: `new Queue('name', ...)` / `new BullMQ.Queue(...)` calls;
 *     `defaultJobOptions` like `{ attempts, backoff: { type } }`.
 *   - Bee-Queue: `new Bee('name', ...)` calls.
 *   - Custom queue: `new CustomQueue({ name, handler })` (multi-line,
 *     balanced-brace walk) or `register('name', handler)` (single-line).
 *   - Message handlers: `onmessage = handler` / `.on('message', handler)`
 *     / `addEventListener('message', handler)`.
 *   - Recurring: `setInterval(handler, ms, ...)` / `setImmediate(handler, ...)`.
 *   - Decorators: `@Task` / `@Queue` annotations on exports.
 *
 * The detector never executes user code. Each detection is a regex
 * match against the file's text, with an attached line/col offset.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { GATEFORGE_SCHEMA_VERSION, type Resource } from '@gateforge/core';
import type { DiscoveryOutcome, Finding } from '@gateforge/plugin-protocol';
import { PACK_VERSION } from './version.js';

/** Attributes attached to every detected `task.resource`. */
export interface TaskResourceAttributes {
  /** Literal task name extracted from the source. */
  taskName: string;
  /** Detection pattern that produced this resource. */
  framework: 'bullmq' | 'bee-queue' | 'custom-queue' | 'message-handler' | 'recurring' | 'decorator';
  /** Retry policy: max attempts + backoff kind (defaults applied if absent). */
  retryPolicy: { maxAttempts: number; backoff: 'fixed' | 'exponential' };
  /** True if the source declares an idempotency key / dedup hint. */
  idempotencyKey: boolean;
  /** Error types whose occurrence marks the task terminal (no retry). */
  terminalOn: string[];
  /** True if the source declares observability hooks (metrics/tracing/listeners). */
  observability: boolean;
  /** Source declaration location (file + line + col). */
  source: { file: string; line: number; col: number };
}

/** Options for {@link createTaskDetector}. */
export interface TaskDetectorOptions {
  /** Override the repo root used for relative path computation. */
  rootDir?: string;
}

/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export interface TaskDetector {
  discover(paths: string[]): Promise<DiscoveryOutcome>;
}

/** Structural copy of the core `Location` shape (core does not re-export the type). */
type Location = Resource['location'];

/** Default retry policy when the source omits it. */
const DEFAULT_RETRY_POLICY: TaskResourceAttributes['retryPolicy'] = {
  maxAttempts: 1,
  backoff: 'fixed',
};

/** Dirs to skip during recursion (kept small to match pack-auth's gateforge.scan conventions). */
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  dist: true,
  '.git': true,
  coverage: true,
  '.turbo': true,
};

/** File extensions to scan (keys include leading dot). */
const SCAN_EXTS: Record<string, true> = {
  '.ts': true,
  '.tsx': true,
  '.js': true,
  '.mjs': true,
  '.cjs': true,
};

/**
 * One internal detection, before resource-construction. The detector
 * collects these, deduplicates by id, and emits one `task.resource`
 * per unique id (duplicates become `DUPLICATE_TASK_ID` findings).
 */
interface RawDetection {
  /** Dotted task name (literal extracted from source; e.g. `email.send`). */
  name: string;
  /** Pattern that produced this detection. */
  framework: TaskResourceAttributes['framework'];
  /** Retry policy extracted from the source (or the default). */
  retryPolicy: TaskResourceAttributes['retryPolicy'];
  /** Idempotency hint extracted from the source. */
  idempotencyKey: boolean;
  /** Terminal error types extracted from the source. */
  terminalOn: string[];
  /** Observability hint extracted from the source. */
  observability: boolean;
  /** Source declaration location (file + line + col). */
  location: Location;
}

/**
 * Creates a discover-capable detector module. The default export of the
 * pack is an instance with no overrides.
 *
 * Args:
 *   options: Optional `{ rootDir }` override (defaults to `process.cwd()`).
 *
 * Returns:
 *   TaskDetector: A `{ discover(paths) }` callable.
 */
export function createTaskDetector(options: TaskDetectorOptions = {}): TaskDetector {
  const rootDir = options.rootDir ?? process.cwd();

  async function discover(paths: string[]): Promise<DiscoveryOutcome> {
    const files = await collectFiles(rootDir, paths);
    const detections: RawDetection[] = [];
    const findings: Finding[] = [];
    const unresolved: DiscoveryOutcome['unresolved'] = [];

    for (const absPath of files) {
      const relPath = relative(rootDir, absPath).split(sep).join(posix.sep);
      let text: string;
      try {
        text = await readFile(absPath, 'utf8');
      } catch (cause) {
        findings.push({
          code: 'PARSE_ERROR',
          detail: `failed to read ${relPath}: ${(cause as Error).message}`,
          locations: [{ file: relPath, line: 1, col: 0 }],
        });
        continue;
      }
      detections.push(...scanFile(relPath, text, findings));
    }

    return finalize(detections, findings, unresolved);
  }

  return { discover };
}

/**
 * Recursively walks the supplied paths, returning absolute file paths
 * matching the scan extensions. Skips `SKIP_DIRS` and any non-existent
 * paths (the caller surfaces those as `PARSE_ERROR` findings when read).
 *
 * Args:
 *   rootDir: Absolute base for path resolution.
 *   paths: Repo-relative or absolute paths (files or dirs).
 *
 * Returns:
 *   Promise<string[]>: Absolute file paths ready for `readFile`.
 */
async function collectFiles(rootDir: string, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const abs = p.startsWith('/') ? p : join(rootDir, p);
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (info.isFile()) {
      for (const ext in SCAN_EXTS) {
        if (abs.endsWith(ext)) {
          out.push(abs);
          break;
        }
      }
      continue;
    }
    if (info.isDirectory()) {
      const entries = await readdir(abs, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS[entry.name] === true) continue;
          out.push(...(await collectFiles(rootDir, [join(abs, entry.name)])));
          continue;
        }
        if (entry.isFile()) {
          for (const ext in SCAN_EXTS) {
            if (entry.name.endsWith(ext)) {
              out.push(join(abs, entry.name));
              break;
            }
          }
        }
      }
    }
  }
  return out.sort();
}

/**
 * Scans one file's source text, returning one `RawDetection` per
 * matched pattern. Emits `AMBIGUOUS_HANDLER` findings for detections
 * that lack a resolvable handler reference.
 *
 * Args:
 *   relPath: Repo-relative file path.
 *   text: The file's full text content.
 *   findings: Findings array to push diagnostic codes into.
 *
 * Returns:
 *   RawDetection[]: One entry per matched pattern (pre-dedup).
 */
function scanFile(relPath: string, text: string, findings: Finding[]): RawDetection[] {
  const detections: RawDetection[] = [];
  const lines = text.split('\n');

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? '';
    const lineNumber = idx + 1;

    // BullMQ: `new Queue('name', ...)` / `Queue('name', ...)`
    const bullmq = matchBullmqLine(line);
    if (bullmq) {
      detections.push({
        name: bullmq,
        framework: 'bullmq',
        retryPolicy: extractRetryPolicy(text, idx) ?? DEFAULT_RETRY_POLICY,
        idempotencyKey: text.includes('jobId') || text.includes('dedupKey'),
        terminalOn: extractTerminalOn(text),
        observability: extractObservabilityHint(text),
        location: { file: relPath, line: lineNumber, col: line.indexOf(bullmq) },
      });
      continue;
    }

    // Bee-Queue: `new Bee('name', ...)`
    const bee = matchBeeLine(line);
    if (bee) {
      detections.push({
        name: bee,
        framework: 'bee-queue',
        retryPolicy: extractRetryPolicy(text, idx) ?? { maxAttempts: 3, backoff: 'exponential' },
        idempotencyKey: text.includes('jobId') || text.includes('dedupKey'),
        terminalOn: extractTerminalOn(text),
        observability: extractObservabilityHint(text),
        location: { file: relPath, line: lineNumber, col: line.indexOf(bee) },
      });
      continue;
    }

    // Single-line custom queue: `register('name'[, handler])`
    const regMatch = matchRegisterLine(line);
    if (regMatch) {
      detections.push({
        name: regMatch.name,
        framework: 'custom-queue',
        retryPolicy: extractRetryPolicy(text, idx) ?? DEFAULT_RETRY_POLICY,
        idempotencyKey: text.includes('idempotencyKey') || text.includes('dedupe'),
        terminalOn: extractTerminalOn(text),
        observability: extractObservabilityHint(text),
        location: { file: relPath, line: lineNumber, col: line.indexOf(regMatch.name) },
      });
      if (!regMatch.hasHandler) {
        findings.push({
          code: 'AMBIGUOUS_HANDLER',
          detail: `custom-queue registration at ${relPath}:${lineNumber} has no resolvable handler reference`,
          locations: [{ file: relPath, line: lineNumber, col: 0 }],
        });
      }
      continue;
    }

    // Message handlers: `onmessage = handler` / `.on('message', handler)`
    const message = matchMessageLine(line);
    if (message) {
      detections.push({
        name: message,
        framework: 'message-handler',
        retryPolicy: DEFAULT_RETRY_POLICY,
        idempotencyKey: text.includes('messageId') || text.includes('dedupKey'),
        terminalOn: extractTerminalOn(text),
        observability: extractObservabilityHint(text),
        location: { file: relPath, line: lineNumber, col: line.indexOf(message) },
      });
      continue;
    }

    // Recurring: `setInterval(handler, ms, ...)` / `setImmediate(handler, ...)`
    const recurring = matchRecurringLine(line);
    if (recurring) {
      detections.push({
        name: recurring,
        framework: 'recurring',
        retryPolicy: DEFAULT_RETRY_POLICY,
        idempotencyKey: false,
        terminalOn: extractTerminalOn(text),
        observability: extractObservabilityHint(text),
        location: { file: relPath, line: lineNumber, col: line.indexOf(recurring) },
      });
      continue;
    }

    // Decorators: `@Task` / `@Queue` on the next non-decorator export
    const decorator = matchDecoratorLine(line);
    if (decorator) {
      detections.push({
        name: 'decorated',
        framework: 'decorator',
        retryPolicy: extractRetryPolicy(text, idx) ?? DEFAULT_RETRY_POLICY,
        idempotencyKey: text.includes('idempotent') || text.includes('jobId'),
        terminalOn: extractTerminalOn(text),
        observability: extractObservabilityHint(text),
        location: { file: relPath, line: lineNumber, col: line.indexOf('@') },
      });
    }
  }

  // Multi-line: `new CustomQueue({ ... name: 'name' ... })` — scan the
  // entire source as one string so the regex can span newlines. The
  // body may contain inner `{}` (e.g. destructured types), so we look
  // for `name:` first and then walk braces to find the matching `}`.
  for (const m of text.matchAll(/new\s+CustomQueue\s*\(/g)) {
    const openIdx = text.indexOf('{', m.index ?? 0);
    if (openIdx < 0) continue;
    const closeIdx = matchingBrace(text, openIdx);
    if (closeIdx < 0) continue;
    const block = text.slice(openIdx + 1, closeIdx);
    const nameMatch = /name\s*:\s*['"]([^'"]+)['"]/.exec(block);
    if (!nameMatch || nameMatch[1] === undefined) continue;
    const name = nameMatch[1];
    const hasHandler = /handler\s*:/.test(block);
    const before = text.slice(0, m.index ?? 0);
    const lineNumber = before.split('\n').length;
    detections.push({
      name,
      framework: 'custom-queue',
      retryPolicy: extractRetryPolicy(text, lineNumber - 1) ?? DEFAULT_RETRY_POLICY,
      idempotencyKey: text.includes('idempotencyKey') || text.includes('dedupe'),
      terminalOn: extractTerminalOn(block),
      observability: /observability\s*:\s*true/.test(block),
      location: { file: relPath, line: lineNumber, col: 0 },
    });
    if (!hasHandler) {
      findings.push({
        code: 'AMBIGUOUS_HANDLER',
        detail: `custom-queue registration at ${relPath}:${lineNumber} has no resolvable handler reference`,
        locations: [{ file: relPath, line: lineNumber, col: 0 }],
      });
    }
  }

  return detections;
}

/** Matches a BullMQ-style queue declaration; returns the literal name. */
function matchBullmqLine(line: string): string | null {
  const m = /new\s+(?:BullMQ\.Queue|Queue)\s*\(\s*['"]([^'"]+)['"]/.exec(line);
  return m && m[1] !== undefined ? m[1] : null;
}

/** Matches a Bee-Queue-style queue declaration; returns the literal name. */
function matchBeeLine(line: string): string | null {
  const m = /new\s+Bee\s*\(\s*['"]([^'"]+)['"]/.exec(line);
  return m && m[1] !== undefined ? m[1] : null;
}

/** Matches a single-line `register('name'[, handler])` call. */
function matchRegisterLine(line: string): { name: string; hasHandler: boolean } | null {
  const m = /register\s*\(\s*['"]([^'"]+)['"]\s*(?=,|\))/.exec(line);
  if (!m || m[1] === undefined) return null;
  // A handler is anything substantive after the second positional arg:
  // an `async`/`function` keyword, an arrow `=>`, a `handler`/`fn`/`cb`
  // token, or another identifier. If the comma has nothing after it on
  // the same line, ambiguous.
  const hasHandler = /(?:async|function|=>|handler\b|\bfn\b|\bcb\b|\bfnc\b)/.test(line);
  return { name: m[1], hasHandler };
}

/** Matches a message-handler registration; returns the handler identifier. */
function matchMessageLine(line: string): string | null {
  if (/\bonmessage\s*=/.test(line)) return 'onmessage';
  const onRe = /\.\s*on\s*\(\s*['"]message['"]/;
  if (onRe.test(line)) {
    const nameMatch = /['"]([^'"]+)['"]\s*,\s*(\w+)/.exec(line);
    return nameMatch?.[2] ?? 'message-handler';
  }
  if (/addEventListener\s*\(\s*['"]message['"]/.test(line)) return 'message-handler';
  return null;
}

/** Matches a recurring schedule (`setInterval(...)` / `setImmediate(...)`); returns the handler identifier. */
function matchRecurringLine(line: string): string | null {
  const intervalRe = /setInterval\s*\(\s*(\w+)/;
  const intervalMatch = intervalRe.exec(line);
  if (intervalMatch && intervalMatch[1] !== undefined) return intervalMatch[1];
  const immediateRe = /setImmediate\s*\(\s*(\w+)/;
  const immediateMatch = immediateRe.exec(line);
  if (immediateMatch && immediateMatch[1] !== undefined) return immediateMatch[1];
  return null;
}

/** Matches a `@Task` / `@Queue` decorator line. */
function matchDecoratorLine(line: string): boolean {
  return /@(Task|Queue)\b/.test(line);
}

/**
 * Returns the index of the `}` matching the `{` at `openIdx`, honoring
 * nested braces and single-line string literals. Returns -1 if
 * unbalanced.
 */
function matchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  let inString: false | "'" | '"' | '`' = false;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inString) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extracts `{ attempts, backoff }` from `defaultJobOptions` or inline
 * `{ attempts, backoff: { type } }` patterns. Returns null when no
 * retry-policy hint is present (callers fall back to the default).
 */
function extractRetryPolicy(source: string, anchorLine: number): TaskResourceAttributes['retryPolicy'] | null {
  const window = surroundingWindow(source, anchorLine, 6);
  const attemptsMatch = /attempts\s*:\s*(\d+)/.exec(window);
  const backoffTypeMatch = /backoff\s*:\s*\{\s*type\s*:\s*['"](\w+)['"]/.exec(window);
  if (attemptsMatch && attemptsMatch[1] !== undefined) {
    const backoff: 'fixed' | 'exponential' =
      backoffTypeMatch && backoffTypeMatch[1] === 'exponential' ? 'exponential' : 'fixed';
    return { maxAttempts: Number(attemptsMatch[1]), backoff };
  }
  const retriesMatch = /retries\s*:\s*(\d+)/.exec(window);
  if (retriesMatch && retriesMatch[1] !== undefined) {
    return { maxAttempts: Number(retriesMatch[1]) + 1, backoff: 'fixed' };
  }
  return null;
}

/** Extracts error-type names from patterns like `terminalOn: ['AuthError', ...]`. */
function extractTerminalOn(source: string): string[] {
  const match = /terminalOn\s*:\s*\[([^\]]+)\]/.exec(source);
  if (!match || match[1] === undefined) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part.length > 0);
}

/** Extracts an observability hint from the file (presence of metrics/tracing/listeners). */
function extractObservabilityHint(source: string): boolean {
  return /\bmetrics\s*[:({]|\btracing\b|\.on\(['"](?:completed|failed|stalled)['"]/.test(source);
}

/** Builds a window of source text around `anchorLine` (±radius). */
function surroundingWindow(source: string, anchorLine: number, radius: number): string {
  const all = source.split('\n');
  const start = Math.max(0, anchorLine - radius);
  const end = Math.min(all.length, anchorLine + radius + 1);
  return all.slice(start, end).join('\n');
}

/**
 * Finalizes raw detections into resources: dedupes by id, emits
 * `DUPLICATE_TASK_ID` findings for collisions, builds the typed
 * resource list with stable ordering.
 */
function finalize(
  detections: RawDetection[],
  findings: Finding[],
  unresolved: DiscoveryOutcome['unresolved'],
): DiscoveryOutcome {
  const byId = new Map<string, RawDetection[]>();
  for (const detection of detections) {
    const id = `task.${detection.name}`;
    const list = byId.get(id) ?? [];
    list.push(detection);
    byId.set(id, list);
  }

  const resources: Resource[] = [];
  for (const [id, group] of byId.entries()) {
    const first = group[0];
    if (!first) continue;
    if (group.length > 1) {
      findings.push({
        code: 'DUPLICATE_TASK_ID',
        detail: `task id "${id}" discovered ${group.length} times; first wins`,
        locations: group.map((g) => g.location),
      });
    }
    const attrs: TaskResourceAttributes = {
      taskName: first.name,
      framework: first.framework,
      retryPolicy: first.retryPolicy,
      idempotencyKey: first.idempotencyKey,
      terminalOn: first.terminalOn,
      observability: first.observability,
      source: first.location,
    };
    resources.push({
      schemaVersion: GATEFORGE_SCHEMA_VERSION,
      id,
      kind: 'task.resource',
      source: first.location.file,
      location: first.location,
      detectorVersion: PACK_VERSION,
      attributes: attrs as unknown as Record<string, unknown>,
    });
  }

  resources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  findings.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
  });

  return { resources, unresolved, findings };
}

const defaultDetector = createTaskDetector();

/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export const discover: TaskDetector['discover'] = (paths) => defaultDetector.discover(paths);