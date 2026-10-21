/**
 * The failure-kind split of the progress stream (plan
 * 20261021_0030_gf_infra_visibility, P2 item 2): a failure whose error
 * message carries the fixture's stable `[gateforge:infra] ` marker is
 * Gateforge failing to provide its own machinery — the operator must
 * see that split in the finish line (`F failed (I infra, T test)`) and
 * in every failure record written to failures.json. The stream decides
 * NOTHING about outcomes here: it only classifies the marker the
 * fixture put into the runner's own error message.
 */
import { describe, expect, it } from 'vitest';
// The pack's fixture entry (built dist, refreshed by the vitest global
// setup) exports the marker the fixture prefixes its machinery errors
// with; the pin test below forbids the stream's copy from drifting.
import { INFRA_FAILURE_MARKER as PACK_FIXTURE_MARKER } from '@gate-forge/pack-playwright/fixture';
import { ProgressStream, type ProgressTestOutcome } from './progress.js';

/** The exact marker the pack's fixture prefixes its infra errors with. */
const INFRA_FAILURE_MARKER = '[gateforge:infra] ';

interface StartedStream {
  progress: ProgressStream;
  lines: string[];
}

const startStream = (expected: number): StartedStream => {
  const lines: string[] = [];
  const progress = new ProgressStream({
    writer: { kind: 'stderr' },
    runner: 'playwright',
    scope: 'full',
    expected,
    writeLine: (line) => lines.push(line),
  });
  return { progress, lines };
};

const failedOutcome = (over: Partial<ProgressTestOutcome> = {}): ProgressTestOutcome => ({
  logicalKey: 'spec.ts#suite>t',
  title: 'suite > t',
  outcome: 'failed',
  message: 'boom',
  stackFrames: ['spec.ts:7'],
  ...over,
});

describe('progress stream: failure kinds', () => {
  it('records kind infra from the marker and test from its absence', () => {
    const { progress } = startStream(2);
    progress.endTest(
      failedOutcome({
        logicalKey: 'a.spec.ts#a',
        title: 'a',
        message: `${INFRA_FAILURE_MARKER}No supervisor-issued witness session for a.spec.ts#a.`,
      }),
    );
    progress.endTest(
      failedOutcome({ logicalKey: 'b.spec.ts#b', title: 'b', message: 'expect(received).toBe(1)' }),
    );
    expect(progress.failures.map((failure) => failure.kind)).toEqual(['infra', 'test']);
  });

  it('counts infra and test failures separately in the finish line', () => {
    const { progress, lines } = startStream(3);
    progress.endTest(failedOutcome({ title: 'infra one', message: `${INFRA_FAILURE_MARKER}x` }));
    progress.endTest(failedOutcome({ title: 'test one', message: 'y' }));
    progress.endTest(failedOutcome({ title: 'test two', message: 'z' }));
    progress.finish();
    const finish = lines.find((line) => line.includes('run finished'));
    expect(finish).toBeDefined();
    expect(finish).toContain('3 failed (1 infra, 2 test)');
  });

  it('classifies the Playwright-serialized shape `Error: <marker> …` as infra', () => {
    // A real fixture throw reaches the stream through Playwright's
    // error serialization, which prefixes `name + ": " + message`
    // (playwright/lib/util.js), so the marker sits behind `Error: `.
    const { progress } = startStream(1);
    progress.endTest(
      failedOutcome({
        logicalKey: 'x.spec.ts#x',
        title: 'x',
        message: `Error: ${INFRA_FAILURE_MARKER}No supervisor-issued witness session for x.spec.ts#x.`,
      }),
    );
    expect(progress.failures[0]?.kind).toBe('infra');
  });

  it('pins the stream marker copy to the pack fixture marker', () => {
    expect(INFRA_FAILURE_MARKER).toBe(PACK_FIXTURE_MARKER);
  });
});
