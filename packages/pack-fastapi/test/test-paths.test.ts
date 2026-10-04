/**
 * Test-directory exclusion (R1-10): the same rule as
 * pack-sqlalchemy's test-paths.ts — a DIRECTORY segment
 * exactly `test`/`tests` (case-insensitive) marks test
 * fixture surface. Apps, routers, and routes declared in
 * such files are not product routes: they never enter the
 * discovery graph, while a file merely NAMED `test_…` next
 * to real code stays business surface.
 *
 * Engine-class tests: deterministic, offline (files + the
 * spawned python detector only).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pythonEnv } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { createFastapiDetector } from '../src/detector.js';
import { dirname, join } from 'node:path';

interface WrapperOutcome {
  resources: ReadonlyArray<{ kind: string; attributes: Record<string, unknown> }>;
  unresolved: ReadonlyArray<Record<string, unknown>>;
  scannedPaths?: string[];
}

/** The product route paths the scan emitted, sorted. */
function paths(outcome: WrapperOutcome): string[] {
  return outcome.resources
    .filter((resource) => resource.kind === 'http.contract')
    .map(
      (resource) =>
        `${String(resource.attributes['method'])} ${String(resource.attributes['normalizedPath'])}`,
    )
    .sort();
}

/** Scans one temp project through the real python detector. */
async function scan(files: Record<string, string>): Promise<WrapperOutcome> {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-test-paths-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const absolute = join(dir, rel);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text, 'utf8');
    }
    const detector = createFastapiDetector({ env: pythonEnv(), cwd: dir });
    return (await detector.discover(Object.keys(files))) as unknown as WrapperOutcome;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('test-directory files are not product routes (R1-10)', () => {
  it('excludes apps, routers, and routes declared under test/tests directories', async () => {
    const outcome = await scan({
      'app/main.py': [
        'from fastapi import FastAPI',
        '',
        'app = FastAPI()',
        '',
        '@app.get("/real")',
        'def real():',
        '    return {}',
      ].join('\n'),
      'tests/middleware/test_x.py': [
        'from fastapi import FastAPI',
        '',
        'app = FastAPI()',
        '',
        '@app.get("/probe")',
        'def probe():',
        '    return {}',
      ].join('\n'),
    });
    expect(paths(outcome)).toEqual(['GET /real']);
    // Coverage evidence stays honest: the fixture file was still scanned.
    expect(outcome.scannedPaths).toContain('tests/middleware/test_x.py');
  });

  it('a file merely named test_… next to real code stays business surface', async () => {
    const outcome = await scan({
      'app/test_utils.py': [
        'from fastapi import FastAPI',
        '',
        'app = FastAPI()',
        '',
        '@app.get("/utils-route")',
        'def utils_route():',
        '    return {}',
      ].join('\n'),
    });
    expect(paths(outcome)).toEqual(['GET /utils-route']);
  });
});
