import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appendAfterStat = vi.hoisted(() => ({ path: null as string | null, line: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const result = actual.statSync(...args);
      const path = args[0];
      if (typeof path === 'string' && path === appendAfterStat.path) {
        appendAfterStat.path = null;
        actual.appendFileSync(path, appendAfterStat.line, 'utf8');
      }
      return result;
    },
  };
});

import { appendSpoolEvent, readSpoolEvents } from '../src/supervisor/spool.js';

const directories: string[] = [];

afterEach(() => {
  appendAfterStat.path = null;
  appendAfterStat.line = '';
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('supervisor lifecycle spool reader', () => {
  it('advances over bytes appended after stat but before read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateforge-spool-race-'));
    directories.push(directory);
    const spoolFile = join(directory, 'events.jsonl');
    appendSpoolEvent(spoolFile, {
      kind: 'testBegin',
      testId: 'race-test',
      workerIndex: 0,
      file: 'specs/race.spec.js',
      titlePath: ['race'],
      project: 'chromium',
    });
    const endLine = `${JSON.stringify({
      kind: 'testEnd',
      testId: 'race-test',
      workerIndex: 0,
      file: 'specs/race.spec.js',
      titlePath: ['race'],
      project: 'chromium',
      outcome: 'passed',
      attempt: 1,
    })}\n`;
    const fileSizeBeforeAppend = Buffer.byteLength(
      `${JSON.stringify({
        kind: 'testBegin',
        testId: 'race-test',
        workerIndex: 0,
        file: 'specs/race.spec.js',
        titlePath: ['race'],
        project: 'chromium',
      })}\n`,
      'utf8',
    );
    appendAfterStat.path = spoolFile;
    appendAfterStat.line = endLine;

    const firstRead = readSpoolEvents(spoolFile, 0);

    expect(firstRead.events.map((event) => event.kind)).toEqual(['testBegin', 'testEnd']);
    expect(firstRead.nextOffset).toBe(fileSizeBeforeAppend + Buffer.byteLength(endLine, 'utf8'));
    const secondRead = readSpoolEvents(spoolFile, firstRead.nextOffset);
    expect(secondRead.events).toEqual([]);
  });

  it('leaves an incomplete trailing line for the next read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateforge-spool-partial-'));
    directories.push(directory);
    const spoolFile = join(directory, 'events.jsonl');
    const completeLine = `${JSON.stringify({ kind: 'testBegin', testId: 'complete' })}\n`;
    const partialLine = '{"kind":"testEnd","testId":"partial"';
    writeFileSync(spoolFile, `${completeLine}${partialLine}`, 'utf8');

    const result = readSpoolEvents(spoolFile, 0);

    expect(result.events.map((event) => event.testId)).toEqual(['complete']);
    expect(result.nextOffset).toBe(Buffer.byteLength(completeLine, 'utf8'));
  });
});
