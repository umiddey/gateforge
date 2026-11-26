import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allCapabilities } from '@gate-forge/core';

const REFERENCE = new URL('../guides/REFERENCE.md', import.meta.url);

describe('guide capability status', () => {
  it('does not label available capabilities fail-closed or unavailable', () => {
    const guide = readFileSync(REFERENCE, 'utf8');
    const rows = guide.split('\n').filter((line) => line.startsWith('| `'));
    const availableNamespaces = allCapabilities()
      .filter((capability) => capability.availability.status === 'available')
      .map((capability) => capability.namespace);

    for (const namespace of availableNamespaces) {
      const row = rows.find((candidate) => candidate.includes(`\`${namespace}:`));
      if (row !== undefined) {
        expect(row, `${namespace} is available in the registry`).not.toMatch(/FAIL-CLOSED|UNAVAILABLE/);
      }
    }
  });
});
