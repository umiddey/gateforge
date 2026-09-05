/**
 * Detector precision regressions (Phase 3 + phase 4): the single-line
 * `register('name', ...)` heuristic must not misread browser/platform
 * registrations as task queues, and handler-less register calls in
 * files without queue evidence must downgrade from the vague
 * `AMBIGUOUS_HANDLER` finding to a typed `UNPROVEN_QUEUE_REGISTRATION`
 * unresolved entry (never a silent swallow, never a false reason).
 *
 * Real dogfood trigger: a consumer repo's frontend
 * `navigator.serviceWorker.register('/sw.js', { scope: '/' })` was
 * emitted as "AMBIGUOUS_HANDLER: custom-queue registration". The phase
 * 4 variant: the SAME registration split across lines — receiver
 * `navigator.serviceWorker` on its own line above `.register(...)` —
 * used to defeat the line-based receiver extraction, so the browser
 * exclusion never fired and the shape degraded to
 * `UNPROVEN_QUEUE_REGISTRATION`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskDetector } from '../src/detector.js';
import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';

const dir = mkdtempSync(join(tmpdir(), 'gateforge-task-precision-'));

/** Writes a repo-relative file into the temp project. */
function write(relPath: string, lines: string[]): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `${lines.join('\n')}\n`);
}

// The exact dogfood false positive: a BROWSER service worker.
write('frontend/src/employee/registerSW.js', [
  `// Employee portal: register the app shell service worker.`,
  `if ('serviceWorker' in navigator) {`,
  `  navigator.serviceWorker.register('/sw.js', { scope: '/' });`,
  `}`,
]);

// The phase 4 dogfood false positive: the SAME browser registration as
// a MULTI-LINE call expression — the receiver sits on its own line, so
// a line-only receiver extraction sees no receiver at all.
write('frontend/src/employee/registerSW.multiline.js', [
  `// Employee portal: register the app shell service worker.`,
  `window.addEventListener('load', () => {`,
  `  navigator.serviceWorker`,
  `    .register('/sw.js', { scope: '/' })`,
  `});`,
]);

// The receiver split over TWO continuation lines must still rebuild
// (`navigator` / `.serviceWorker` / `.register(...)`).
write('frontend/src/employee/registerSW.split.js', [
  `navigator`,
  `  .serviceWorker`,
  `  .register('/sw.js', { scope: '/' });`,
]);

// Spec-driven exclusion matrix: any receiver rooted at a browser
// global, any chain carrying a `serviceWorker` segment, and the
// conventional `serviceWorkerRegistration` handle are never queues.
write('assets/platform.js', [
  `window.register('/mock-sw.js');`,
  `document.register('/hydrator.js');`,
  `caches.register('/asset-group-v1');`,
  `workbox.register('/precache-manifest.js');`,
  `container.serviceWorker.register('/deep-chain.js');`,
  `serviceWorkerRegistration.register('/periodic-sync.js');`,
]);

// Task-ish shape with NO queue evidence: not provably a registration
// of a task queue — typed unresolved instead of a worker signal.
write('lib/flags.js', [
  `export const registry = { register: (name, opts) => opts };`,
  `registry.register('feature.flag.refresh', { scope: 'global' });`,
]);

// Queue evidence (bullmq import) keeps the bare register task-shaped;
// the browser line must stay silent even in a queue-y file.
write('jobs/audit.js', [
  `import { Queue } from 'bullmq';`,
  `navigator.serviceWorker.register('/sw.js', { scope: '/' });`,
  `export const handle = register('audit.flush');`,
]);

// Handler-bearing register stays accepted (no blocking output) without
// any evidence.
write('workers/sync.js', [
  `register('sync_accounts', async (job) => {`,
  `  await run(job.data);`,
  `});`,
]);

/** Scans the temp project once for all assertions below. */
async function scan(): Promise<DiscoveryOutcome> {
  const detector = createTaskDetector({ rootDir: dir });
  return detector.discover(['frontend', 'assets', 'lib', 'jobs', 'workers']);
}

/** Signals located under a repo-relative prefix. */
const signalsUnder = (outcome: DiscoveryOutcome, prefix: string): number =>
  outcome.classificationSignals.filter((s) => s.location.file.startsWith(prefix)).length;

describe('detector precision: browser registrations vs queue registrations', () => {
  let outcome: DiscoveryOutcome;

  it('discovers the temp project without crashing', async () => {
    outcome = await scan();
    expect(outcome.scannedPaths).toContain('frontend/src/employee/registerSW.js');
  });

  it('emits NOTHING for the dogfood service-worker registration', () => {
    expect(signalsUnder(outcome, 'frontend')).toBe(0);
    expect(outcome.findings.some((f) => f.locations.some((l) => l.file.startsWith('frontend')))).toBe(false);
    expect(outcome.unresolved.some((u) => u.location.file.startsWith('frontend'))).toBe(false);
  });

  it('emits NOTHING for the MULTI-LINE dogfood registration (receiver on its own line)', () => {
    // Phase 4 regression: the receiver `navigator.serviceWorker` sits
    // on the line above `.register(...)`; the rebuilt receiver chain
    // must hit the browser exclusion BEFORE the queue-evidence gate,
    // so no UNPROVEN_QUEUE_REGISTRATION can appear.
    const rel = 'frontend/src/employee/registerSW.multiline.js';
    expect(outcome.scannedPaths).toContain(rel);
    expect(signalsUnder(outcome, 'frontend')).toBe(0);
    expect(outcome.findings.some((f) => f.locations.some((l) => l.file === rel))).toBe(false);
    expect(outcome.unresolved.some((u) => u.location.file === rel)).toBe(false);
  });

  it('rebuilds a receiver split over two continuation lines', () => {
    // `navigator` / `.serviceWorker` / `.register(...)` — bounded
    // lookback joins the chain and the browser exclusion still fires.
    const rel = 'frontend/src/employee/registerSW.split.js';
    expect(outcome.scannedPaths).toContain(rel);
    expect(signalsUnder(outcome, 'frontend')).toBe(0);
    expect(outcome.findings.some((f) => f.locations.some((l) => l.file === rel))).toBe(false);
    expect(outcome.unresolved.some((u) => u.location.file === rel)).toBe(false);
  });

  it('never treats browser-global receivers as queues (window/document/caches/workbox/serviceWorker)', () => {
    expect(signalsUnder(outcome, 'assets')).toBe(0);
    expect(outcome.findings.some((f) => f.locations.some((l) => l.file.startsWith('assets')))).toBe(false);
    expect(outcome.unresolved.some((u) => u.location.file.startsWith('assets'))).toBe(false);
  });

  it('downgrades a handler-less register with no queue evidence to a typed unresolved', () => {
    // Not task-shaped: no worker signal, no AMBIGUOUS_HANDLER — but a
    // TRUE typed blocking reason instead of a silent swallow.
    expect(signalsUnder(outcome, 'lib')).toBe(0);
    const libUnresolved = outcome.unresolved.filter((u) => u.location.file.startsWith('lib'));
    expect(libUnresolved).toHaveLength(1);
    expect(libUnresolved[0]?.code).toBe('UNPROVEN_QUEUE_REGISTRATION');
    expect(libUnresolved[0]?.detail).toContain('lib/flags.js');
    expect(outcome.findings.some((f) => f.locations.some((l) => l.file.startsWith('lib')))).toBe(false);
  });

  it('queue evidence keeps AMBIGUOUS_HANDLER for a bare register', () => {
    // bullmq import proves the file is queue domain: the handler-less
    // register keeps its AMBIGUOUS_HANDLER finding. (Phase 4: no
    // classification signals exist anywhere anymore, so "task-shaped"
    // is observable only through the blocking vocabulary.)
    expect(
      outcome.findings.some(
        (f) => f.code === 'AMBIGUOUS_HANDLER' && f.locations.some((l) => l.file.startsWith('jobs')),
      ),
    ).toBe(true);
    // The browser line inside this queue-y file must stay silent —
    // queue evidence must not resuscitate browser registrations.
    expect(outcome.unresolved.some((u) => u.location.file.startsWith('jobs'))).toBe(false);
  });

  it('handler-bearing register produces no blocking output without any queue evidence', () => {
    // The handler short-circuit accepts the register as task-shaped:
    // no UNPROVEN_QUEUE_REGISTRATION downgrade and no finding.
    expect(signalsUnder(outcome, 'workers')).toBe(0);
    expect(outcome.findings.some((f) => f.locations.some((l) => l.file.startsWith('workers')))).toBe(false);
    expect(outcome.unresolved.some((u) => u.location.file.startsWith('workers'))).toBe(false);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
