/**
 * Static serial-scope detection in Playwright spec sources (serial-group
 * selection): when a selected test belongs to a describe in serial mode,
 * the run must select every test of that serial group in file order, so
 * the supervisor needs a spec's serial scopes as data.
 *
 * Detection is STATIC PARSING because Playwright's own list surface
 * never exposes a suite's declared mode: the `--list --reporter=json`
 * enumeration carries only title/file/line per suite, so serialness is
 * unreadable from the runner's listing. Three declaration forms are
 * detected — `test.describe.serial(...)`, a describe whose body calls
 * `test.describe.configure({ mode: 'serial' })` (before OR after the
 * tests it governs), and a file-level
 * `test.describe.configure({ mode: 'serial' })` (the whole file is one
 * serial scope). A scope that declares nothing serial is never
 * detected: expansion must not be guessed.
 */
import { describe, expect, it } from 'vitest';
import { serialScopesOf } from '../src/discovery/serial-scopes.js';

describe('static serial-scope detection', () => {
  it('detects a describe.serial group covering its body in file order', () => {
    const scopes = serialScopesOf(
      [
        "import { test, expect } from '@playwright/test';",
        "test.describe.serial('journey', () => {",
        "  test('step one', async () => {});",
        "  test('step two', async () => {});",
        "  test('step three', async () => {});",
        '});',
        "test('loose', async () => {});",
        '',
      ].join('\n'),
    );
    expect(scopes).toEqual([
      expect.objectContaining({
        kind: 'describe',
        parentTitlePath: [],
        title: 'journey',
        startLine: 2,
        endLine: 6,
      }),
    ]);
    // The scope's range covers exactly the three member tests (lines
    // 3-5), never the sibling test registered after the group.
    expect(scopes[0]?.startLine).toBeLessThan(3);
    expect(scopes[0]?.endLine).toBeGreaterThan(5);
    expect(scopes[0]?.endLine).toBeLessThan(7);
  });

  it('detects a describe whose body configures serial mode after its tests', () => {
    const scopes = serialScopesOf(
      [
        "import { test } from '@playwright/test';",
        "test.describe('configured', () => {",
        "  test('first', async () => {});",
        "  test('second', async () => {});",
        "  test.describe.configure({ mode: 'serial' });",
        '});',
        '',
      ].join('\n'),
    );
    expect(scopes).toEqual([
      expect.objectContaining({ kind: 'describe', parentTitlePath: [], title: 'configured', startLine: 2, endLine: 6 }),
    ]);
  });

  it('detects a file-level configure({ mode: serial }) as one file-wide scope', () => {
    const scopes = serialScopesOf(
      [
        "import { test } from '@playwright/test';",
        "test.describe.configure({ mode: 'serial' });",
        "test.describe('group a', () => {",
        "  test('a1', async () => {});",
        '});',
        "test('loose', async () => {});",
        '',
      ].join('\n'),
    );
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ kind: 'file', parentTitlePath: [], title: null });
    // The file-wide scope spans every test in the file.
    expect(scopes[0]?.startLine).toBe(1);
    expect(scopes[0]?.endLine).toBeGreaterThanOrEqual(6);
  });

  it('detects a nested serial describe with its parent title path', () => {
    const scopes = serialScopesOf(
      [
        "import { test } from '@playwright/test';",
        "test.describe('outer', () => {",
        "  test.describe.serial('journey', () => {",
        "    test('step one', async () => {});",
        '  });',
        "  test('outside the journey', async () => {});",
        '});',
        '',
      ].join('\n'),
    );
    expect(scopes).toEqual([
      expect.objectContaining({
        kind: 'describe',
        parentTitlePath: ['outer'],
        title: 'journey',
        startLine: 3,
        endLine: 5,
      }),
    ]);
  });

  it('a configure inside a nested describe marks that describe, never the file', () => {
    const scopes = serialScopesOf(
      [
        "import { test } from '@playwright/test';",
        "test.describe('outer', () => {",
        "  test.describe('inner', () => {",
        "    test('i1', async () => {});",
        "    test.describe.configure({ mode: 'serial' });",
        '  });',
        "  test('o1', async () => {});",
        '});',
        '',
      ].join('\n'),
    );
    expect(scopes).toEqual([
      expect.objectContaining({
        kind: 'describe',
        parentTitlePath: ['outer'],
        title: 'inner',
        startLine: 3,
        endLine: 6,
      }),
    ]);
  });

  it('never detects a scope that declares nothing serial', () => {
    const scopes = serialScopesOf(
      [
        "import { test } from '@playwright/test';",
        "test.describe('plain', () => {",
        "  test('p1', async () => {});",
        '});',
        "test.describe.configure({ mode: 'default' });",
        "test.describe('computed', () => { test.describe.configure({ mode: process.env.MODE }); });",
        '',
      ].join('\n'),
    );
    expect(scopes).toEqual([]);
  });
});
