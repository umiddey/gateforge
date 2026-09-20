/**
 * `gateforge enforcement doctor` (plan 2026-09-13 Phase 5 item 7, ADR
 * 0005 D1): one honest diagnostic surface. The assertions pin the two
 * honesty rules that matter most: a hook is NEVER reported as managed
 * protection, and a managed mode whose authoritative `.git` is
 * agent-writable is reported as NOT active. Exit is 0 whenever the
 * doctor runs (diagnostic), `--json` is deterministic.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';
import { installCommitHook } from '../src/git-hooks.js';

/** Sanitized env for direct module calls. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

interface DoctorJson {
  mode: 'standard' | 'managed';
  strictE2E: boolean;
  ready: boolean;
  checks: Array<{ id: string; status: 'ok' | 'warn' | 'fail'; detail: string }>;
}

/** Parses the doctor's deterministic JSON output. */
function parseDoctor(stdout: string): DoctorJson {
  return JSON.parse(stdout) as DoctorJson;
}

function checkById(report: DoctorJson, id: string): { status: string; detail: string } {
  const found = report.checks.find((entry) => entry.id === id);
  expect(found, `check '${id}' present`).toBeTruthy();
  return found as { status: string; detail: string };
}

describe('enforcement doctor (standard mode reports honestly)', () => {
  it('reports mode/boundary honestly: a missing hook is never managed protection', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0); // the doctor always runs (diagnostic)
      const report = parseDoctor(result.stdout);
      expect(report.mode).toBe('standard');
      expect(report.strictE2E).toBe(false);
      expect(report.checks.map((entry) => entry.id)).toEqual([
        'behavior-profile',
        'config',
        'enforcement-mode',
        'hook',
        'managed-guarantee',
        'observer',
        'runner',
        'snapshot',
        'trusted-binary-policy',
      ]);
      expect(checkById(report, 'config').status).toBe('ok');
      // Behavior profile not configured: ok (basic behavior only).
      const behavior = checkById(report, 'behavior-profile');
      expect(behavior.status).toBe('ok');
      expect(behavior.detail).toContain('not configured');
      // No hook installed: a warning, precisely.
      const hook = checkById(report, 'hook');
      expect(hook.status).toBe('warn');
      expect(hook.detail).toContain('no pre-commit hook');
      // THE honesty rule: standard mode never claims managed protection.
      const managed = checkById(report, 'managed-guarantee');
      expect(managed.status).toBe('warn');
      expect(managed.detail).toContain('managed guarantees NOT active');
      expect(managed.detail).toContain('ADR 0005 D1');
      // Runner readiness is a real probe (no node_modules above the tmp repo).
      expect(checkById(report, 'runner').status).toBe('fail');
      expect(checkById(report, 'snapshot').status).toBe('ok');
      expect(report.ready).toBe(false);
    });
  });

  it('even an ACTIVE hook stays standard: the boundary warning remains', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      expect(installCommitHook(repo.root, gitEnv()).status).toBe('installed');
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0);
      const report = parseDoctor(result.stdout);
      const hook = checkById(report, 'hook');
      expect(hook.status).toBe('ok');
      expect(hook.detail).toContain('installed and active');
      // Still honest: the hook alone is not managed protection.
      expect(checkById(report, 'managed-guarantee').detail).toContain('managed guarantees NOT active');
    });
  });
});

describe('enforcement doctor (managed mode with an agent-writable .git)', () => {
  it('reports managed guarantees NOT active when the authoritative repo is agent-writable', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Switch the fixture config to managed mode (schema-valid section).
      const configPath = repo.path('.gateforge.yml');
      repo.writeFiles({
        '.gateforge.yml': `${readFileSync(configPath, 'utf8')}\nenforcement:\n  mode: managed\n`,
      });
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0); // diagnostic: per-check statuses, not an exit gate
      const report = parseDoctor(result.stdout);
      expect(report.mode).toBe('managed');
      const managed = checkById(report, 'managed-guarantee');
      expect(managed.status).toBe('fail');
      expect(managed.detail).toContain('managed guarantees NOT active: authoritative repository is agent-writable');
      expect(managed.detail).toContain('broker commit');
      expect(report.ready).toBe(false);
    });
  });
});

describe('enforcement doctor (determinism + text surface)', () => {
  it('--json is byte-identical across runs; text mode lists per-check statuses', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const first = await runCli(repo, ['enforcement', 'doctor', '--json']);
      const second = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(first.stdout).toBe(second.stdout);
      const text = await runCli(repo, ['enforcement', 'doctor']);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('gateforge enforcement doctor');
      expect(text.stdout).toContain('[OK] config');
      expect(text.stdout).toContain('diagnostic only; exit 0 either way');
    });
  });
});
