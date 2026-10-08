/**
 * Serial-group selection expansion (pure planning seam): a selected test
 * that belongs to a serial scope selects the WHOLE group in file order.
 * The expansion draws members from the full planned set (already free of
 * quarantined rows), stays inside the member's own file, never touches a
 * non-serial describe, and reports one record per group naming what was
 * added.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandSerialSelection } from '../src/serial-expansion.js';
import type { PlannedRow } from '../src/execution.js';

const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gf-serial-expansion-'));
  DIRECTORIES.push(dir);
  mkdirSync(join(dir, 'specs'), { recursive: true });
  return dir;
}

/** One planned row the way `planExpectedSet` builds them. */
function row(file: string, project: string | null, titlePath: readonly string[]): PlannedRow {
  const logicalKey = `${file}#${titlePath.join('>')}`;
  return {
    planned: { logicalKey, project, file, titlePath: [...titlePath], frameworkId: null },
    input: { logicalKey, project, file, titlePath: [...titlePath], blockingAnnotations: [] },
  };
}

/** Writes a spec file and returns the line of each 1-based source line label. */
function writeSpec(
  root: string,
  file: string,
  lines: readonly string[],
): void {
  writeFileSync(join(root, file), `${lines.join('\n')}\n`, 'utf8');
}

/** The journey spec the tests share: serial group + standalone describe. */
function writeJourneySpec(root: string, file: string): void {
  writeSpec(root, file, [
    "import { test } from '@playwright/test';",
    "test.describe.serial('journey', () => {",
    "  test('writes the row', async () => {});",
    "  test('lists the row', async () => {});",
    "  test('reads the row', async () => {});",
    '});',
    "test.describe('standalone', () => {",
    "  test('checks setup', async () => {});",
    '});',
    '',
  ]);
}

/** The logicalKey → source line map a catalog lookup provides in production. */
function lineMap(entries: ReadonlyArray<{ file: string; titlePath: readonly string[]; line: number }>) {
  const byKey = new Map<string, number>(
    entries.map((entry) => [`${entry.file}#${entry.titlePath.join('>')}`, entry.line]),
  );
  return (logicalKey: string): number | undefined => byKey.get(logicalKey);
}

describe('expandSerialSelection', () => {
  it('expands a selected serial step to its whole group in file order', () => {
    const root = tempProject();
    const file = 'specs/journey.spec.js';
    writeJourneySpec(root, file);
    const writes = row(file, 'chromium', ['journey', 'writes the row']);
    const lists = row(file, 'chromium', ['journey', 'lists the row']);
    const reads = row(file, 'chromium', ['journey', 'reads the row']);
    const setup = row(file, 'chromium', ['standalone', 'checks setup']);
    const lines = lineMap([
      { file, titlePath: ['journey', 'writes the row'], line: 3 },
      { file, titlePath: ['journey', 'lists the row'], line: 4 },
      { file, titlePath: ['journey', 'reads the row'], line: 5 },
      { file, titlePath: ['standalone', 'checks setup'], line: 8 },
    ]);

    const result = expandSerialSelection({
      cwd: root,
      rows: [reads],
      allRows: [writes, lists, reads, setup],
      lineOf: lines,
    });

    // The selection is the whole group, in the plan's own order.
    expect(result.rows.map((entry) => entry.planned.logicalKey)).toEqual([
      lists.planned.logicalKey,
      reads.planned.logicalKey,
      writes.planned.logicalKey,
    ]);
    // The added members are exactly steps 1-2: the record lists them in
    // FILE order, the key set is the plan's own sorted order.
    expect(result.addedLogicalKeys).toEqual([lists.planned.logicalKey, writes.planned.logicalKey]);
    expect(result.expansions).toEqual([
      {
        describe: 'journey',
        file,
        added: 2,
        logicalKeys: [writes.planned.logicalKey, lists.planned.logicalKey],
      },
    ]);
  });

  it('never expands a non-serial describe', () => {
    const root = tempProject();
    const file = 'specs/journey.spec.js';
    writeJourneySpec(root, file);
    const setup = row(file, 'chromium', ['standalone', 'checks setup']);
    const lines = lineMap([{ file, titlePath: ['standalone', 'checks setup'], line: 8 }]);

    const result = expandSerialSelection({
      cwd: root,
      rows: [setup],
      allRows: [setup],
      lineOf: lines,
    });

    expect(result.rows).toEqual([setup]);
    expect(result.addedLogicalKeys).toEqual([]);
    expect(result.expansions).toEqual([]);
  });

  it('expands describe-level and file-level configure({ mode: serial }) groups', () => {
    const root = tempProject();
    const configuredFile = 'specs/configured.spec.js';
    writeSpec(root, configuredFile, [
      "import { test } from '@playwright/test';",
      "test.describe('configured', () => {",
      "  test('first', async () => {});",
      "  test('second', async () => {});",
      "  test.describe.configure({ mode: 'serial' });",
      '});',
      '',
    ]);
    const wholeFile = 'specs/whole-file.spec.js';
    writeSpec(root, wholeFile, [
      "import { test } from '@playwright/test';",
      "test.describe.configure({ mode: 'serial' });",
      "test.describe('group a', () => {",
      "  test('a one', async () => {});",
      '});',
      "test('loose', async () => {});",
      '',
    ]);
    const first = row(configuredFile, 'chromium', ['configured', 'first']);
    const second = row(configuredFile, 'chromium', ['configured', 'second']);
    const aOne = row(wholeFile, 'chromium', ['group a', 'a one']);
    const loose = row(wholeFile, 'chromium', ['loose']);
    const lines = lineMap([
      { file: configuredFile, titlePath: ['configured', 'first'], line: 3 },
      { file: configuredFile, titlePath: ['configured', 'second'], line: 4 },
      { file: wholeFile, titlePath: ['group a', 'a one'], line: 4 },
      { file: wholeFile, titlePath: ['loose'], line: 6 },
    ]);

    const configuredResult = expandSerialSelection({
      cwd: root,
      rows: [second],
      allRows: [first, second],
      lineOf: lines,
    });
    expect(configuredResult.addedLogicalKeys).toEqual([first.planned.logicalKey]);
    expect(configuredResult.expansions).toEqual([
      { describe: 'configured', file: configuredFile, added: 1, logicalKeys: [first.planned.logicalKey] },
    ]);

    const fileResult = expandSerialSelection({
      cwd: root,
      rows: [loose],
      allRows: [aOne, loose],
      lineOf: lines,
    });
    // A file-level serial scope covers every test in the file, and the
    // record names the file-level group.
    expect(fileResult.rows.map((entry) => entry.planned.logicalKey)).toEqual([
      aOne.planned.logicalKey,
      loose.planned.logicalKey,
    ]);
    expect(fileResult.expansions).toEqual([
      { describe: null, file: wholeFile, added: 1, logicalKeys: [aOne.planned.logicalKey] },
    ]);
  });

  it('never leaks an expansion into another file', () => {
    const root = tempProject();
    writeJourneySpec(root, 'specs/journey.spec.js');
    const other = 'specs/other.spec.js';
    writeSpec(root, other, [
      "import { test } from '@playwright/test';",
      "test.describe.serial('journey', () => {",
      "  test('other file step', async () => {});",
      '});',
      '',
    ]);
    const reads = row('specs/journey.spec.js', 'chromium', ['journey', 'reads the row']);
    const writes = row('specs/journey.spec.js', 'chromium', ['journey', 'writes the row']);
    const foreign = row(other, 'chromium', ['journey', 'other file step']);
    const lines = lineMap([
      { file: 'specs/journey.spec.js', titlePath: ['journey', 'reads the row'], line: 5 },
      { file: 'specs/journey.spec.js', titlePath: ['journey', 'writes the row'], line: 3 },
      { file: other, titlePath: ['journey', 'other file step'], line: 3 },
    ]);

    const result = expandSerialSelection({
      cwd: root,
      rows: [reads],
      allRows: [reads, writes, foreign],
      lineOf: lines,
    });

    expect(result.addedLogicalKeys).toEqual([writes.planned.logicalKey]);
    expect(
      result.expansions.every((entry) => entry.file === 'specs/journey.spec.js'),
      'expansions stay in the selected test’s own file',
    ).toBe(true);
  });

  it('adds only members the plan still carries and merges repeats into one record', () => {
    const root = tempProject();
    const file = 'specs/journey.spec.js';
    writeJourneySpec(root, file);
    const writes = row(file, 'chromium', ['journey', 'writes the row']);
    const lists = row(file, 'chromium', ['journey', 'lists the row']);
    const reads = row(file, 'chromium', ['journey', 'reads the row']);
    const lines = lineMap([
      { file, titlePath: ['journey', 'writes the row'], line: 3 },
      { file, titlePath: ['journey', 'lists the row'], line: 4 },
      { file, titlePath: ['journey', 'reads the row'], line: 5 },
    ]);

    // `lists` is absent from the full planned set (quarantined rows
    // leave planning before this point), so expanding `reads` adds only
    // the member the plan still carries — never the quarantined one.
    const result = expandSerialSelection({
      cwd: root,
      rows: [reads],
      allRows: [writes, reads],
      lineOf: lines,
    });

    expect(result.addedLogicalKeys).toEqual([writes.planned.logicalKey]);
    expect(result.rows.map((entry) => entry.planned.logicalKey)).toEqual([
      reads.planned.logicalKey,
      writes.planned.logicalKey,
    ]);
    expect(result.expansions).toEqual([
      { describe: 'journey', file, added: 1, logicalKeys: [writes.planned.logicalKey] },
    ]);
  });

  it('a spec that declares nothing serial expands nothing', () => {
    const root = tempProject();
    const file = 'specs/plain.spec.js';
    writeSpec(root, file, [
      "import { test } from '@playwright/test';",
      "test.describe('plain', () => {",
      "  test('p one', async () => {});",
      "  test('p two', async () => {});",
      '});',
      '',
    ]);
    const one = row(file, 'chromium', ['plain', 'p one']);
    const two = row(file, 'chromium', ['plain', 'p two']);
    const lines = lineMap([
      { file, titlePath: ['plain', 'p one'], line: 3 },
      { file, titlePath: ['plain', 'p two'], line: 4 },
    ]);

    const result = expandSerialSelection({ cwd: root, rows: [two], allRows: [one, two], lineOf: lines });

    expect(result.rows).toEqual([two]);
    expect(result.addedLogicalKeys).toEqual([]);
    expect(result.expansions).toEqual([]);
  });
});
