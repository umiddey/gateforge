/**
 * 0.9.1: the `.gitignore` engine-state block `init` writes is a
 * Gateforge-owned policy input (kind `ignore-wiring`) when the
 * managed block is the ONLY difference from the base revision of
 * the change set. A real setup commit stages exactly that block
 * (`init` appends it while writing the skeleton), and it must not
 * turn the setup commit into a product change under strictE2E.
 *
 * The security boundary is exact: any other added, removed or
 * changed line — and any `.gitignore` that does not exist at the
 * base revision — is NOT owned, because a `.gitignore` can carry
 * arbitrary ignore wiring an agent could abuse to hide product
 * changes from the scan.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@gate-forge/core';
import type { GateforgeConfig } from '@gate-forge/core';
import type { GateforgeOwnedInput } from '../src/gateforge-owned.js';
import { configYml } from './helpers.js';
import {
  ENGINE_STATE_IGNORE_COMMENT,
  ENGINE_STATE_IGNORE_ENTRIES,
  gateforgeOwnedInputs,
} from '../src/gateforge-owned.js';

/** The base revision's `.gitignore`: none of Gateforge's block. */
const BASE_IGNORE = 'node_modules/\n';

/** The managed block exactly as `init` appends it. */
const MANAGED_BLOCK = `${ENGINE_STATE_IGNORE_COMMENT}\n${ENGINE_STATE_IGNORE_ENTRIES.join('\n')}\n`;

/** The candidate `.gitignore`: the base plus the managed block. */
const CANDIDATE_IGNORE = `${BASE_IGNORE}${MANAGED_BLOCK}`;

/**
 * Runs the classifier over one candidate `.gitignore` in a temp
 * dir, against one base text (`null` = absent at the base
 * revision; `withBaseText = false` = no reader at all).
 */
function classify(
  candidate: string,
  base: string | null,
  withBaseText = true,
): Map<string, GateforgeOwnedInput> {
  const dir = mkdtempSync(join(tmpdir(), 'gf-owned-'));
  try {
    const configPath = join(dir, '.gateforge.yml');
    writeFileSync(configPath, configYml(), 'utf8');
    const config = loadConfig(configPath);
    writeFileSync(join(dir, '.gitignore'), candidate, 'utf8');
    const baseText: ((path: string) => string | null) | undefined =
      withBaseText
        ? (path) => (path === '.gitignore' ? base : null)
        : undefined;
    return gateforgeOwnedInputs(dir, ['.gitignore'], config, baseText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the .gitignore engine-state block as a policy input', () => {
  it('classifies the managed block alone (base + block) as owned ignore-wiring', () => {
    const owned = classify(CANDIDATE_IGNORE, BASE_IGNORE);
    expect([...owned.entries()]).toEqual([
      ['.gitignore', { path: '.gitignore', kind: 'ignore-wiring' }],
    ]);
  });

  it('does not classify a candidate with an extra non-managed line (base + block + dist/)', () => {
    const owned = classify(`${CANDIDATE_IGNORE}dist/\n`, BASE_IGNORE);
    expect(owned.has('.gitignore')).toBe(false);
  });

  it('does not classify a candidate that removes a base line (block only, no node_modules/)', () => {
    const owned = classify(MANAGED_BLOCK, BASE_IGNORE);
    expect(owned.has('.gitignore')).toBe(false);
  });

  it('does not classify .gitignore when no base-text reader is given', () => {
    const owned = classify(CANDIDATE_IGNORE, BASE_IGNORE, false);
    expect(owned.has('.gitignore')).toBe(false);
  });

  it('does not classify a .gitignore that is absent at the base revision', () => {
    const owned = classify(MANAGED_BLOCK, null);
    expect(owned.has('.gitignore')).toBe(false);
  });
});
