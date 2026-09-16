/**
 * The pack's discover entry: a pure TypeScript GPP/3 in-process
 * detector that scans `.ts`/`.js`/`.mjs` files for background-task
 * signatures. The outcome carries the pack's typed blocking
 * vocabulary (`AMBIGUOUS_HANDLER`, `PARSE_ERROR` findings and the
 * typed `UNPROVEN_QUEUE_REGISTRATION` unresolved entry) plus per-file
 * scan coverage; it emits no resources and no classification signals
 * (see the phase 4 note below).
 *
 * Mirrors the public shape of `packages/pack-sqlalchemy/src/detector.ts`:
 *   - `discover(paths: string[])` returns the GPP/3 `DiscoveryOutcome`
 *     shape (resources, unresolved, findings).
 *   - `createTaskDetector()` is the factory.
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
 * Precision guards (Phase 3): the single-line `register('name', ...)`
 * shape is receiver-agnostic by nature, so it is narrowed two ways.
 *   - Browser/platform registration APIs (service workers, caches,
 *     workbox routes) are NEVER queue registrations: a receiver rooted
 *     at a browser global (`navigator`/`window`/`document`/`caches`/
 *     `workbox`) — or any `*.serviceWorker.register(...)` chain — is
 *     out of scope and produces no detector output at all. The receiver
 *     is rebuilt across MULTI-LINE call expressions too (bounded
 *     lookback): in `navigator.serviceWorker\n  .register('/sw.js')`
 *     the receiver sits on the previous line, and a line-only
 *     extraction used to miss it (real dogfood false positive).
 *   - A handler-less `register('name')` is only task-shaped when the
 *     file shows real queue evidence (a known queue-library import or
 *     a queue constructor). Otherwise the shape is not provably a task
 *     registration: the detector emits a typed
 *     `UNPROVEN_QUEUE_REGISTRATION` unresolved entry instead of a
 *     vague `AMBIGUOUS_HANDLER` finding (never a silent swallow, and
 *     never a FALSE reason).
 *
 * Classification signals (dogfood remediation phase 4): NONE. This
 * pack once minted `internality`/`worker` reachability signals for
 * every detected task, targeted at model names GUESSED from the
 * worker file (model/repository import-path segments, every
 * PascalCase identifier, stripped task-name fragments). Those targets
 * are guesses about OTHER detectors' resources — this pack emits no
 * resources of its own — so in real repos they mostly matched nothing
 * and every miss surfaced as a `STALE_SIGNAL_TARGET` blocker (236 in
 * the unified dogfood) while adding no information: a reachability
 * signal can only ever SUPPORT an internality certificate, and
 * guessed certification is exactly what the certificate must not
 * rest on. Unknown exposure already defaults user-facing and unknown
 * lifecycle already defaults enabled (ADR 0003 D5), so removal flips
 * no classification and shrinks no obligation set — it only stops
 * false certification and stale-target noise. Core's
 * `STALE_SIGNAL_TARGET` detection remains for genuinely stale
 * authority signals; the `trustedInternalEntryPoints` worker binding
 * (`detector: gateforge.pack-task`) simply stays unexercised, so
 * internality certification via that category is honestly unavailable
 * (`INCOMPLETE_PROOF_SCOPE`, user-facing) instead of guess-based.
 * The `classificationSignals` outcome field stays in the wire shape
 * (protocol contract) and is always empty.
 *
 * The detector never executes user code. Each detection is a regex
 * match against the file's text, with an attached line/col offset.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { GATEFORGE_SCHEMA_VERSION, type Resource } from '@gate-forge/core';
import type { DiscoveryOutcome, Finding } from '@gate-forge/plugin-protocol';

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

/** Source extensions this pack scans. */
const SCAN_EXTS: Record<string, true> = {
  '.ts': true,
  '.js': true,
  '.mjs': true,
  '.cjs': true,
};

/** Directories skipped during recursive scans. */
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  dist: true,
  coverage: true,
  '.git': true,
};

/**
 * Receiver roots that are browser/platform globals and therefore can
 * never be task queues. WHY: the single-line `register('name', ...)`
 * heuristic is receiver-agnostic, so a browser Service Worker
 * registration like `navigator.serviceWorker.register('/sw.js',
 * { scope: '/' })` used to be misread as a custom-queue registration
 * (real dogfood false positive). A call whose receiver is rooted at
 * one of these globals is a platform registration API by definition.
 */
const BROWSER_RECEIVER_ROOTS: Record<string, true> = {
  navigator: true,
  window: true,
  document: true,
  caches: true,
  workbox: true,
};

/**
 * Module names that mark a file as task-queue domain (real queue
 * evidence): known queue libraries the detector recognizes elsewhere
 * (`bullmq`, `bee-queue`, celery, ...). Tested against import/require
 * specifiers only — never the whole file text — so a comment mention
 * cannot fabricate evidence.
 */
const QUEUE_LIBRARY_MODULE = /\b(?:bullmq|bull|bee-queue|celery|kue|agenda|pg-boss|sidekiq)\b/i;
/**
 * One internal detection, before signal-construction.
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

    const scanned: string[] = [];
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
      scanned.push(relPath);
      detections.push(...scanFile(relPath, text, findings, unresolved));
    }

    return finalize(detections, findings, unresolved, scanned);
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
 * matched pattern. Emits `AMBIGUOUS_HANDLER` findings for queue-proven
 * registrations that lack a resolvable handler reference, and typed
 * `UNPROVEN_QUEUE_REGISTRATION` unresolved entries for handler-less
 * `register(...)` calls in files with no queue evidence. Browser /
 * platform registration calls (service workers, caches, workbox)
 * produce no output at all.
 *
 * Args:
 *   relPath: Repo-relative file path.
 *   text: The file's full text content.
 *   findings: Findings array to push diagnostic codes into.
 *   unresolved: Unresolved array to push typed reasons into.
 *
 * Returns:
 *   RawDetection[]: One entry per matched pattern (pre-dedup).
 */
function scanFile(relPath: string, text: string, findings: Finding[], unresolved: DiscoveryOutcome['unresolved']): RawDetection[] {
  const detections: RawDetection[] = [];
  const lines = text.split('\n');

  // Queue evidence is file-scoped and only needed when a `register(`
  // call lacks a resolvable handler; computed lazily (at most once
  // per file) to keep the per-line hot path regex-only.
  let queueEvidence: boolean | null = null;
  const hasQueueEvidenceCached = (): boolean => {
    if (queueEvidence === null) queueEvidence = hasQueueEvidence(text);
    return queueEvidence;
  };

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

    // Custom queue: `register('name'[, handler])`. A bare receiver is
    // the pack's custom-queue runtime; a receiver rooted at a browser
    // global is a platform registration (service worker, caches,
    // workbox) and is skipped entirely. The receiver is rebuilt across
    // multi-line call expressions (see `receiverOfCall`), so a browser
    // chain split over lines is excluded just like the single-line one.
    const regMatch = matchRegisterLine(line, lines, idx);
    if (regMatch) {
      if (!isBrowserRegistrationReceiver(regMatch.receiver)) {
        if (regMatch.hasHandler || hasQueueEvidenceCached()) {
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
        } else {
          // Handler-less `register('name')` in a file with no queue
          // evidence: the shape is not provably a task registration, so
          // it must NOT yield a vague AMBIGUOUS_HANDLER finding (and,
          // since phase 4, no signal exists to mint either). Keep the
          // blocking contract with a typed unresolved reason that is
          // TRUE instead.
          unresolved.push({
            code: 'UNPROVEN_QUEUE_REGISTRATION',
            detail: `register('${regMatch.name}') at ${relPath}:${lineNumber} has no resolvable handler reference and the file shows no task-queue evidence (known queue-library import or queue constructor)`,
            location: { file: relPath, line: lineNumber, col: 0 },
          });
        }
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
        location: {
          file: relPath,
          line: lineNumber,
          col: Math.max(0, line.indexOf(message)),
        },
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
  // No queue-evidence gate is needed here: the `CustomQueue` receiver
  // is constructed from the pack's own queue runtime, so the shape is
  // provably queue-related (unlike the receiver-agnostic single-line
  // `register(...)` heuristic).
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
function matchRegisterLine(line: string, lines: string[], idx: number): { name: string; hasHandler: boolean; receiver: string | null } | null {
  const m = /register\s*\(\s*['"]([^'"]+)['"]\s*(?=,|\))/.exec(line);
  if (!m || m[1] === undefined) return null;
  // A handler is anything substantive after the second positional arg:
  // an `async`/`function` keyword, an arrow `=>`, a `handler`/`fn`/`cb`
  // token, or another identifier. If the comma has nothing after it on
  // the same line, ambiguous.
  const hasHandler = /(?:async|function|=>|handler\b|\bfn\b|\bcb\b|\bfnc\b)/.test(line);
  return { name: m[1], hasHandler, receiver: receiverOfCall(lines, idx, m.index) };
}

/**
 * Extracts the receiver chain preceding a `register(` call, e.g.
 * `navigator.serviceWorker` in `navigator.serviceWorker.register(...)`.
 * Returns null for a bare `register(...)` call (the pack's custom-queue
 * runtime shape). Tolerates optional chaining (`obj?.register(...)`).
 */
function receiverOf(line: string, callIndex: number): string | null {
  const before = line.slice(0, callIndex).replace(/\?\.$/, '.');
  const m = /([\w$]+(?:\.[\w$]+)*)\.$/.exec(before);
  return m && m[1] !== undefined ? m[1] : null;
}

/**
 * How many previous non-empty lines the multi-line receiver rebuild may
 * inspect. Bounded so a runaway chain can never scan the whole file.
 */
const RECEIVER_LOOKBACK_LINES = 3;

/**
 * Receiver extraction with multi-line support (dogfood phase 4): when
 * the match line itself carries no receiver, the call is a MULTI-LINE
 * member expression —
 *
 *     navigator.serviceWorker
 *       .register('/sw.js', { scope: '/' })
 *
 * — and the receiver lives on the preceding line(s). The chain is
 * rebuilt by joining the tail of each previous non-empty line with the
 * head accumulated so far and re-running the exact single-line
 * receiver grammar, so a receiver split over up to three continuation
 * lines (`navigator` / `.serviceWorker` / `.register(...)`) resolves to
 * `navigator.serviceWorker`. Comment lines never contribute a receiver
 * (a mention in a comment is not a receiver), and a statement
 * terminator (`;`/`{`/`}`) breaks the chain. Single-line calls return
 * from the direct extraction before any lookback, so their behavior is
 * byte-identical.
 */
function receiverOfCall(lines: string[], idx: number, callIndex: number): string | null {
  const line = lines[idx] ?? '';
  const direct = receiverOf(line, callIndex);
  if (direct !== null) return direct;
  // Only a member continuation (head ends with the access dot — `.`,
  // `?.`, `(expr).`) or a bare call (head empty) can be continued from
  // a previous line; anything else has no receiver to rebuild.
  let head = line.slice(0, callIndex).trim();
  if (head !== '' && !head.endsWith('.')) return null;
  let inspected = 0;
  for (let back = idx - 1; back >= 0 && inspected < RECEIVER_LOOKBACK_LINES; back -= 1) {
    const raw = lines[back] ?? '';
    const trimmed = raw.trim();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      continue;
    }
    inspected += 1;
    const candidate = raw.trimEnd() + head;
    const receiver = receiverOf(candidate, candidate.length);
    // A previous line that itself begins with a member dot is an
    // INTERMEDIATE continuation (`navigator` / `.serviceWorker` /
    // `.register(...)`): keep accumulating instead of returning the
    // partial chain rooted mid-expression.
    if (receiver !== null && !trimmed.startsWith('.')) return receiver;
    head = candidate.trimStart();
    if (/[;{}]$/.test(head)) return null;
  }
  return null;
}

/**
 * True when the receiver of a `register(` call is a browser/platform
 * registration API rather than a task queue. WHY: service-worker,
 * cache, and workbox registrations share the `register('...')` shape
 * but have nothing to do with background tasks (real dogfood false
 * positive on `navigator.serviceWorker.register('/sw.js', ...)`).
 * Conservative by design: a receiver rooted at a browser global is
 * NEVER a queue, and the service-worker handle is often aliased
 * (`serviceWorkerRegistration`), so both the root and any
 * `serviceWorker` segment are checked.
 */
function isBrowserRegistrationReceiver(receiver: string | null): boolean {
  if (receiver === null) return false;
  const segments = receiver.split('.');
  const root = segments[0] ?? '';
  // Rooted at a browser global: `navigator.*`, `window.*`,
  // `document.*`, `caches.*`, `workbox.*`.
  if (BROWSER_RECEIVER_ROOTS[root] === true) return true;
  // Any `*.serviceWorker.register(...)` chain (aliased receivers too).
  if (segments.includes('serviceWorker')) return true;
  // The conventional alias for the `navigator.serviceWorker.ready` handle.
  return receiver === 'serviceWorkerRegistration';
}

/**
 * True when the file shows real task-queue evidence: an import (or
 * require / dynamic import) from a known queue library — bullmq, bull,
 * celery, kue, agenda, pg-boss, sidekiq, bee-queue — or from any
 * queue-named module (the pack's custom-queue runtime, e.g.
 * `./custom-queue-runtime.js`), or a queue constructor
 * (`new Queue|Bee|CustomQueue(`) in the file. Used to gate the loose
 * single-line `register('name')` heuristic so it only fires on shapes
 * that are provably queue-related.
 */
function hasQueueEvidence(text: string): boolean {
  const specifierRe = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(specifierRe)) {
    const spec = m[1];
    if (spec === undefined) continue;
    if (QUEUE_LIBRARY_MODULE.test(spec)) return true;
    if (/queue/i.test(spec)) return true;
  }
  // A receiver constructed from a queue library in the same file is
  // evidence too (`new Queue(...)` then `queue.register(...)`), as is
  // the pack's own custom-queue constructor.
  return /\bnew\s+(?:BullMQ\.Queue|Queue|Bee|CustomQueue)\s*\(/.test(text);
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
 * Finalizes raw detections into the discovery outcome (dogfood
 * remediation phase 4): NO classification signals are minted. The
 * targets this pack once guessed for its `internality`/`worker`
 * reachability signals (model/repository import-path segments, every
 * PascalCase identifier in the file, stripped task-name fragments) are
 * path-derived guesses about OTHER detectors' resources — this pack
 * emits no resources of its own — so in real repos they mostly matched
 * nothing and every miss became a `STALE_SIGNAL_TARGET` blocker while
 * adding no information. Unknown exposure already defaults user-facing
 * and unknown lifecycle already defaults enabled (ADR 0003 D5), so the
 * removal flips no classification and shrinks no obligation set. Core
 * keeps detecting genuinely stale authority signals; the field stays
 * in the wire shape (protocol contract) and is always empty.
 *
 * `_detections` is intentionally unused: the detection inventory still
 * drives the register-branch findings/unresolved gates inside
 * `scanFile`, and the pack's outcome carries no resource channel.
 */
function finalize(
  _detections: RawDetection[],
  findings: Finding[],
  unresolved: DiscoveryOutcome['unresolved'],
  scanned: string[] = [],
): DiscoveryOutcome {
  findings.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
  });

  return {
    resources: [],
    unresolved,
    findings,
    classificationSignals: [],
    scannedPaths: scanned.sort(),
  };
}

const defaultDetector = createTaskDetector();

/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export const discover: TaskDetector['discover'] = (paths) => defaultDetector.discover(paths);