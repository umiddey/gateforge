/**
 * A hand-edited `plugins[].version` names a contract, not a fix.
 *
 * Copying a neighbouring entry's version (the documented way to add a
 * pack by editing `.gateforge.yml`) makes EVERY command exit 2 with
 * `signal contract violated`. Nothing in that line says which field is
 * wrong, what the pack's detector actually declares, or how to get the
 * right value — and the two numbers that differ (the pack's npm version
 * and the detector's declared version) are not the same thing.
 *
 * Pinned here: the message names the field, both versions, and the fix
 * (`gateforge init --plugins <id>` writes the pin the installed pack
 * declares). The exit code is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { configYml, installFixture, runCli } from './helpers.js';

/** A plugin module whose signals carry its own id at version 0.2.0. */
const DETECTOR_020_SOURCE = `export default {
  discover(paths) {
    return {
      resources: [],
      unresolved: [],
      findings: [],
      classificationSignals: [
        {
          schemaVersion: 1,
          target: { resourceName: 'accounts' },
          dimension: 'internality',
          assertion: true,
          basis: 'declaration',
          source: 'gateforge:internal',
          location: { file: 'src/accounts.txt', line: 1, col: 0 },
          detector: { id: 'tenant.pack', version: '0.2.0' },
        },
      ],
    };
  },
};
`;

describe('a plugins[].version that does not match the detector says how to fix it', () => {
  it('names the field, both versions and the fix, and keeps exit 2', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'tenant-pack.mjs': DETECTOR_020_SOURCE });
      repo.writeFiles({
        '.gateforge.yml': configYml({
          plugins: `  - id: tenant.pack
    version: '0.1.0'
    transport: in-process
    module: ./tenant-pack.mjs`,
        }),
      });
      const result = await runCli(repo, ['discover', '--json']);
      expect(result.code).toBe(2);
      // The pinned identity, the one the config declared, and the one
      // the detector actually reports are all named.
      expect(result.stderr).toContain("in-process plugin 'tenant.pack'@'0.1.0'");
      expect(result.stderr).toContain('"tenant.pack"@"0.2.0"');
      // The field to edit and the value to put in it.
      expect(result.stderr).toContain("set version: '0.2.0'");
      expect(result.stderr).toContain('.gateforge.yml');
      // And the command that writes the right pin by itself.
      expect(result.stderr).toContain('gateforge init --plugins tenant.pack');
    });
  });
});
