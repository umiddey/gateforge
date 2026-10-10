import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GateforgeReporter } from '../src/reporter/reporter.js';
import { appendSpoolEvent, readSpoolEvents, spoolPathFor } from '../src/supervisor/spool.js';
import { PLAYWRIGHT_CLI, ROOT, run } from './helpers.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), 'gf-ui-steps-'));
  roots.push(stateDir);
  const reporter = new GateforgeReporter({ stateDir, runId: 'ui-run' });
  const step = (id: string, category: string, title: string, retry = 0) =>
    reporter.onStepEnd({ id }, { retry }, { category, title });
  const end = (id: string, file = 'a.spec.ts', retry = 0) => {
    reporter.onTestEnd({ id, location: { file, line: 1, column: 1 } }, { status: 'passed', retry });
    const event = readSpoolEvents(spoolPathFor(stateDir, 'ui-run'), 0).events.at(-1);
    if (event === undefined) throw new Error('reporter did not emit testEnd');
    return event;
  };
  return { step, end };
}

describe('runner-reported UI step signatures', () => {
  it('distinguishes clicks and assertions on the same page, independent of source location', () => {
    const { step, end } = harness();
    for (const [id, button, text] of [['a', 'A', 'X'], ['b', 'B', 'Y'], ['copy', 'A', 'X']]) {
      step(id!, 'pw:api', `Click getByRole('button', { name: '${button}' })`);
      step(id!, 'expect', `Expect "toHaveText" getByText('${text}')`);
    }
    const a = end('a', 'first.spec.ts');
    const b = end('b', 'second.spec.ts');
    const copy = end('copy', 'elsewhere.spec.ts');
    expect(a.uiSteps).toHaveLength(2);
    expect(a.uiSteps).not.toEqual(b.uiSteps);
    expect(a.uiSteps).toEqual(copy.uiSteps);
    expect(a.uiSteps?.join(' ')).not.toContain('spec.ts');
    expect(a.uiSteps?.join(' ')).toContain('X');
  });

  it('normalizes long digit runs and UUIDs and deduplicates before sorting', () => {
    const { step, end } = harness();
    step('a', 'pw:api', "Click getByText('INV-2026-0001')");
    step('b', 'pw:api', "Click getByText('INV-2026-0002')");
    step('a', 'pw:api', "Fill locator('#123e4567-e89b-12d3-a456-426614174000')");
    step('b', 'pw:api', "Fill locator('#a9876543-e89b-12d3-a456-426614174111')");
    const a = end('a');
    const b = end('b');
    expect(a.uiSteps).toHaveLength(2);
    expect(b.uiSteps).toEqual(a.uiSteps);
  });

  it('retains locator-free keyboard and mouse input and normalizes typed values', () => {
    const { step, end } = harness();
    const titles = [
      'Press "Tab"', 'Key down "Shift"', 'Key up "Shift"',
      'Type "INV-2026-0001"', 'Insert "123e4567-e89b-12d3-a456-426614174000"',
      'Mouse move', 'Mouse down', 'Mouse up', 'Mouse wheel', 'Click', 'Double click',
    ];
    for (const title of titles) step('a', 'pw:api', title);
    const expected = [
      'Press "Tab"', 'Key down "Shift"', 'Key up "Shift"',
      'Type "INV-<digits>-<digits>"', 'Insert "<uuid>"',
      'Mouse move', 'Mouse down', 'Mouse up', 'Mouse wheel', 'Click', 'Double click',
    ].map(title => `pw:api:${title}`).sort();
    expect(end('a').uiSteps).toEqual(expected);
  });

  it('ignores fixture, hook, test.step and navigation-free internal API steps', () => {
    const { step, end } = harness();
    for (const category of ['fixture', 'hook', 'test.step']) step('a', category, 'Click A');
    step('a', 'pw:api', 'Create browser context');
    step('a', 'pw:api', 'Create page');
    step('a', 'pw:api', "Click getByText('A')");
    expect(end('a').uiSteps).toEqual(["pw:api:Click getByText('A')"]);
  });

  it('caps unique entries at 500 and marks truncation, without leaking retries', () => {
    const { step, end } = harness();
    for (let i = 0; i < 501; i++) step('a', 'pw:api', `Click locator('#button-${i}')`);
    const capped = end('a');
    expect(capped).toMatchObject({ uiStepsTruncated: true });
    expect(capped.uiSteps).toHaveLength(500);
    step('a', 'pw:api', "Click getByText('retry')", 1);
    expect(end('a', 'a.spec.ts', 1).uiSteps).toEqual(["pw:api:Click getByText('retry')"]);
  });

  it('drops malformed optional UI fields when writing and reading spool events', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gf-ui-spool-'));
    roots.push(stateDir);
    const file = spoolPathFor(stateDir, 'ui-run');
    const malformed = {
      kind: 'testEnd', testId: 'a', workerIndex: 0, file: null, titlePath: [], project: null,
      outcome: 'passed', uiSteps: ['valid', 42], uiStepsTruncated: 'yes',
    };
    appendSpoolEvent(file, malformed as never);
    const written = readSpoolEvents(file, 0).events[0];
    expect(written).not.toHaveProperty('uiSteps');
    expect(written).not.toHaveProperty('uiStepsTruncated');
    writeFileSync(file, `${JSON.stringify(malformed)}\n`);
    const read = readSpoolEvents(file, 0).events[0];
    expect(read).not.toHaveProperty('uiSteps');
    expect(read).not.toHaveProperty('uiStepsTruncated');
  });

  it('captures real Playwright 1.58 action and locator expect titles through the CJS reporter', () => {
    const project = mkdtempSync(join(tmpdir(), 'gf-ui-real-'));
    roots.push(project);
    const stateDir = join(project, 'state');
    writeFileSync(join(project, 'playwright.config.cjs'), `module.exports = {
      testDir: '.', workers: 1,
      reporter: [[${JSON.stringify(join(ROOT, 'packages/pack-playwright/dist/reporter/reporter.cjs'))},
        { stateDir: ${JSON.stringify(stateDir)}, runId: 'real-ui' }]],
    };`);
    for (const [file, button, text] of [['a', 'A', 'X'], ['b', 'B', 'Y'], ['copy', 'A', 'X']]) {
      writeFileSync(join(project, `${file}.spec.cjs`), `
        const { test, expect } = require(${JSON.stringify(join(ROOT, 'node_modules/@playwright/test'))});
        test('journey', async ({ page }) => {
          await page.setContent('<button>A</button><button>B</button><p>X</p><p>Y</p><input>');
          await test.step('wrapper must not be recorded', async () => {
            await page.getByRole('button', { name: '${button}' }).click();
            await expect(page.getByText('${text}')).toHaveText('${text}');
          });
          await page.keyboard.press('Tab');
          await page.keyboard.down('Shift');
          await page.keyboard.up('Shift');
          await page.locator('input').focus();
          await page.keyboard.type('INV-2026-0001');
          await page.keyboard.insertText('123e4567-e89b-12d3-a456-426614174000');
          await page.mouse.move(1, 1);
          await page.mouse.down();
          await page.mouse.up();
          await page.mouse.wheel(0, 10);
          await page.mouse.click(1, 1);
          await page.mouse.dblclick(1, 1);
        });
      `);
    }
    const outcome = run(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', join(project, 'playwright.config.cjs')], { cwd: project });
    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    const events = readSpoolEvents(spoolPathFor(stateDir, 'real-ui'), 0).events.filter((event) => event.kind === 'testEnd');
    expect(events).toHaveLength(3);
    const signatures = events.map((event) => event.uiSteps);
    expect(signatures[0]).toContain("pw:api:Click getByRole('button', { name: 'A' })");
    expect(signatures[0]).toContain("expect:Expect \"toHaveText\" getByText('X')");
    for (const title of [
      'Press "Tab"', 'Key down "Shift"', 'Key up "Shift"',
      'Type "INV-<digits>-<digits>"', 'Insert "<uuid>"',
      'Mouse move', 'Mouse down', 'Mouse up', 'Mouse wheel', 'Click', 'Double click',
    ]) expect(signatures[0], title).toContain(`pw:api:${title}`);
    expect(signatures[0]).not.toEqual(signatures[1]);
    expect(signatures[0]).toEqual(signatures[2]);
    expect(signatures[0]?.join(' ')).not.toContain('wrapper must not be recorded');
  }, 60_000);
});
