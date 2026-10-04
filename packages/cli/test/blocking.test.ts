/**
 * The generated-hook gate-args reader (`generatedHookGateArgs`):
 * the gate invocation a generated hook script records at
 * generation time is the ONE thing that distinguishes a strict
 * init's staged commit gate from the changed-scoped default —
 * so `adopt` (which re-wires through the shared path) must be
 * able to read it back and keep it, never silently downgrade.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { CaptureStream, type Io } from '../src/index.js';
import {
  ensureHookScript,
  generatedHookGateArgs,
} from '../src/commands/blocking.js';

const HOOK_PATH = '.gateforge/hooks/gateforge-check.mjs';

/** An Io bound to the temp repo, like `runCli` builds. */
function ioFor(repo: TempRepo): Io {
  return {
    cwd: repo.root,
    env: process.env,
    stdout: new CaptureStream(),
    stderr: new CaptureStream(),
  };
}

describe('generatedHookGateArgs — the gate args a generated hook records', () => {
  it('reads the args a generated hook was wired with', () => {
    withTempRepo({}, (repo) => {
      ensureHookScript(ioFor(repo), null, ['check', '--staged', '--require-e2e']);
      expect(generatedHookGateArgs(repo.root)).toEqual([
        'check',
        '--staged',
        '--require-e2e',
      ]);
    });
  });

  it('returns null when no hook exists', () => {
    withTempRepo({}, (repo) => {
      expect(generatedHookGateArgs(repo.root)).toBeNull();
    });
  });

  it('returns null for a foreign hook file', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({ [HOOK_PATH]: 'console.log("owner-owned hook");\n' });
      expect(generatedHookGateArgs(repo.root)).toBeNull();
    });
  });

  it('returns null when the recorded args line is unparsable', () => {
    withTempRepo({}, (repo) => {
      ensureHookScript(ioFor(repo), null, ['check', '--staged']);
      // The markers still identify it as generated; the args
      // line itself is corrupt.
      const corrupt = readFileSync(repo.path(HOOK_PATH), 'utf8').replace(
        'const args = ["check","--staged"];',
        'const args = [check staged];',
      );
      writeFileSync(repo.path(HOOK_PATH), corrupt, 'utf8');
      expect(generatedHookGateArgs(repo.root)).toBeNull();
    });
  });

  it('returns null when the recorded args are not a string array', () => {
    withTempRepo({}, (repo) => {
      ensureHookScript(ioFor(repo), null, ['check', '--staged']);
      const wrongShape = readFileSync(repo.path(HOOK_PATH), 'utf8').replace(
        'const args = ["check","--staged"];',
        'const args = {"gate": "check"};',
      );
      writeFileSync(repo.path(HOOK_PATH), wrongShape, 'utf8');
      expect(generatedHookGateArgs(repo.root)).toBeNull();
    });
  });
});
