/**
 * The failures.json contract after the failure-kind plan (plan
 * 20261021_0030_gf_infra_visibility, P2 item 3): schemaVersion 2 and a
 * `kind` per failure (`infra` when the fixture's stable marker was in
 * the error message, `test` otherwise). No repository reader parses
 * this document (only artifact path lists name it), so the bump is
 * additive for every consumer.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeTestFailures } from './state.js';

interface FailuresDocument {
  schemaVersion: number;
  runId: string;
  failures: Array<{ logicalKey: string; kind?: string }>;
}

describe('writeTestFailures: schemaVersion 2 with per-failure kind', () => {
  it('writes kind per failure and bumps schemaVersion to 2', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gf-state-failures-'));
    try {
      writeTestFailures(stateDir, 'run-1', [
        {
          logicalKey: 'a.spec.ts#a',
          title: 'a',
          message: '[gateforge:infra] No supervisor-issued witness session for a.spec.ts#a.',
          stackFrames: ['a.spec.ts:7'],
          kind: 'infra',
        },
        {
          logicalKey: 'b.spec.ts#b',
          title: 'b',
          message: 'expect(received).toBe(1)',
          stackFrames: [],
          kind: 'test',
        },
      ]);
      const raw = readFileSync(join(stateDir, 'failures.json'), 'utf8');
      const document = JSON.parse(raw) as FailuresDocument;
      expect(document.schemaVersion).toBe(2);
      expect(document.runId).toBe('run-1');
      expect(document.failures.map((failure) => failure.kind)).toEqual(['infra', 'test']);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

/**
 * The supervisor-timing.json contract (plan 20261021_0030_gf_infra_visibility,
 * P3): the always-on per-path supervisor→witness timing aggregates,
 * written with the shared atomic state-file writer.
 */
import { writeSupervisorTiming } from './state.js';

interface TimingDocument {
  schemaVersion: number;
  runId: string;
  paths: Array<{ path: string; count: number; maxMs: number; nearBudget: number; budgetMs: number }>;
}

describe('writeSupervisorTiming: always-on per-path timing aggregates', () => {
  it('writes schemaVersion 1 with the run id and the sorted path entries', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gf-state-timing-'));
    try {
      writeSupervisorTiming(stateDir, 'run-9', [
        { path: '/sessions/open', count: 4, maxMs: 4600, nearBudget: 3, budgetMs: 5000 },
        { path: '/sessions/close', count: 4, maxMs: 40, nearBudget: 0, budgetMs: 5000 },
      ]);
      const raw = readFileSync(join(stateDir, 'supervisor-timing.json'), 'utf8');
      const document = JSON.parse(raw) as TimingDocument;
      expect(document.schemaVersion).toBe(1);
      expect(document.runId).toBe('run-9');
      expect(document.paths).toEqual([
        { path: '/sessions/close', count: 4, maxMs: 40, nearBudget: 0, budgetMs: 5000 },
        { path: '/sessions/open', count: 4, maxMs: 4600, nearBudget: 3, budgetMs: 5000 },
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('writes an empty paths list when no supervisor call was made', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gf-state-timing-'));
    try {
      writeSupervisorTiming(stateDir, 'run-10', []);
      const raw = readFileSync(join(stateDir, 'supervisor-timing.json'), 'utf8');
      const document = JSON.parse(raw) as TimingDocument;
      expect(document.paths).toEqual([]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
