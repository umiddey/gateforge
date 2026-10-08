import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keepFailureArtifacts } from '../src/failure-artifacts.js';

const roots: string[] = [];
function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'gf-failure-artifacts-'));
  roots.push(root);
  return { run: join(root, 'run'), keep: join(root, 'state') };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('keepFailureArtifacts', () => {
  it("keeps a failed test's error context after the run directory is deleted", () => {
    const { run, keep } = dirs();
    const failed = join(run, 'playwright-artifacts', 'spec-a-chromium');
    mkdirSync(failed, { recursive: true });
    writeFileSync(join(failed, 'error-context.md'), 'button "Save" missing');

    const kept = keepFailureArtifacts(run, keep);
    rmSync(run, { recursive: true, force: true });

    expect(kept).toBe(join(keep, 'last-failures'));
    expect(readFileSync(join(keep, 'last-failures', 'spec-a-chromium', 'error-context.md'), 'utf8')).toBe(
      'button "Save" missing',
    );
  });

  it('keeps the run trace with the failure artifacts (runtime.yml trace)', () => {
    const { run, keep } = dirs();
    const failed = join(run, 'playwright-artifacts', 'spec-a-chromium');
    mkdirSync(failed, { recursive: true });
    writeFileSync(join(failed, 'trace.zip'), 'zip-bytes');
    writeFileSync(join(failed, 'error-context.md'), 'expected X to be Y');

    const kept = keepFailureArtifacts(run, keep);
    rmSync(run, { recursive: true, force: true });

    expect(kept).toBe(join(keep, 'last-failures'));
    expect(readFileSync(join(keep, 'last-failures', 'spec-a-chromium', 'trace.zip'), 'utf8')).toBe('zip-bytes');
  });

  it("replaces the previous run's artifacts instead of mixing them", () => {
    const { run, keep } = dirs();
    mkdirSync(join(keep, 'last-failures', 'old-test'), { recursive: true });
    mkdirSync(join(run, 'playwright-artifacts', 'new-test'), { recursive: true });
    writeFileSync(join(run, 'playwright-artifacts', 'new-test', 'error-context.md'), 'x');

    keepFailureArtifacts(run, keep);

    expect(existsSync(join(keep, 'last-failures', 'old-test'))).toBe(false);
    expect(existsSync(join(keep, 'last-failures', 'new-test', 'error-context.md'))).toBe(true);
  });

  it('a run without artifacts clears a stale copy and reports nothing kept', () => {
    const { run, keep } = dirs();
    mkdirSync(join(keep, 'last-failures', 'old-test'), { recursive: true });
    mkdirSync(join(run, 'playwright-artifacts'), { recursive: true });

    expect(keepFailureArtifacts(run, keep)).toBeNull();
    expect(existsSync(join(keep, 'last-failures'))).toBe(false);
    expect(keepFailureArtifacts(join(run, 'absent'), keep)).toBeNull();
  });
});
