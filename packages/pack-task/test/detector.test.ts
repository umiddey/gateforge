/**
 * Detector unit suite: scans every fixture under `fixtures/` and
 * asserts the discovery output matches the documented pack vocabulary.
 *
 * Phase 4 (dogfood remediation): the pack mints NO classification
 * signals. It once minted `internality`/`worker` reachability signals
 * targeted at model names GUESSED from the worker file (import-path
 * segments, every PascalCase identifier, stripped task-name fragments);
 * every guess that matched no discovered resource became a
 * `STALE_SIGNAL_TARGET` blocker (236 in the unified dogfood) while
 * adding no information — unknown exposure already defaults user-facing
 * and unknown lifecycle already defaults enabled (ADR 0003 D5). The
 * assertions below pin the honest post-Phase-4 wire: `resources` empty
 * AND `classificationSignals` empty, with the blocking vocabulary
 * (findings/unresolved) still flowing. On the pre-Phase-4 detector the
 * empty-signal assertions FAIL (it minted dozens of guessed targets for
 * these same fixtures) — that is the red/green line for this defect.
 */
import { describe, expect, it } from 'vitest';
import { ALL_FIXTURE_PATHS, detectorOverFixtures } from './helpers.js';
import type { DiscoveryOutcome, Finding } from '@gateforge/plugin-protocol';

/** Returns the set of finding codes. */
const codes = (findings: Finding[]): string[] => findings.map((f) => f.code);

/** The two browser-registration fixtures must produce nothing at all. */
const BROWSER_FIXTURES = ['browser-registration.ts', 'browser-registration-multiline.ts'];

describe('pack-task detector (background-task discovery)', () => {
  let outcome: DiscoveryOutcome;

  it('discovers every fixture without crashing; resources and signals stay empty', async () => {
    outcome = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    expect(outcome.resources).toHaveLength(0);
    // Phase 4: no guessed-target signals. (Red on the pre-Phase-4
    // detector, which minted `internality`/`worker` signals for these
    // same fixtures from path-derived model-name guesses.)
    expect(outcome.classificationSignals).toEqual([]);
  });

  it('mints no signals even for queue-heavy files full of model-ish identifiers', async () => {
    // bullmq.ts declares `email.send`/`billing.refund` and mentions
    // `SendEmail`/`ProcessRefund` — every one of these used to become a
    // guessed signal target (singular + plural). Phase 4: the detector
    // stops guessing; route/model linkage is the corroborating
    // mechanisms' job, never a path-derived guess.
    const bullmqOutcome = await detectorOverFixtures().discover(['bullmq.ts']);
    expect(bullmqOutcome.classificationSignals).toEqual([]);
  });

  it('emits an AMBIGUOUS_HANDLER finding for register calls without a handler', () => {
    expect(codes(outcome.findings)).toContain('AMBIGUOUS_HANDLER');
  });

  it('emits NOTHING for the browser-registration fixtures (a service worker is not a queue)', () => {
    // Phase 3 precision regression: `navigator.serviceWorker.register`
    // and friends used to be misread as custom-queue registrations.
    // Phase 4 variant: the multi-line dogfood shape (receiver on its
    // own line) used to defeat the receiver extraction entirely and
    // degrade to UNPROVEN_QUEUE_REGISTRATION. The detector must produce
    // no signal, no finding, and no unresolved entry for either file.
    for (const file of BROWSER_FIXTURES) {
      expect(outcome.findings.some((f) => f.locations.some((l) => l.file === file))).toBe(false);
      expect(outcome.unresolved.some((u) => u.location.file === file)).toBe(false);
    }
  });

  it('keeps every emitted location schema-valid (non-negative column)', () => {
    for (const finding of outcome.findings) {
      for (const location of finding.locations) {
        expect(location.col).toBeGreaterThanOrEqual(0);
      }
    }
    for (const unresolved of outcome.unresolved) {
      expect(unresolved.location.col).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic (invariant 7): two scans produce identical output', async () => {
    const a = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    const b = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('keeps the wire honest: blocking vocabulary still flows while signals stay empty', () => {
    // The empty-signal contract must never become a silent swallow:
    // the fixtures still carry a real AMBIGUOUS_HANDLER blocking entry.
    expect(outcome.classificationSignals).toEqual([]);
    expect(outcome.findings.length).toBeGreaterThan(0);
    expect(outcome.scannedPaths?.length ?? 0).toBeGreaterThan(0);
  });
});
