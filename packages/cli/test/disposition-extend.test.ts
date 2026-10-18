/**
 * `gateforge disposition extend` (plan 2026-10-17 P2): the CLI rewrite
 * of one owner disposition's `expiresAt` in the document that owns it,
 * the `extensions` audit entry, the over-max and unknown-target
 * refusals, and the digest/pin note. The command is a fail-closed text
 * edit of trusted policy — these tests run the real command in-process
 * against fixture repositories and read back what landed on disk.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

const NOW = '2026-01-01T00:00:00.000Z';
const OLD_EXPIRY = '2026-01-10T00:00:00.000Z';
const NEW_EXPIRY = '2026-01-20T00:00:00.000Z';
const OVER_MAX_EXPIRY = '2026-02-15T00:00:00.000Z';

const ENDPOINT_ID = 'global.http-post-orders-abc123';

/** Fixture behavior document: one dispositioned endpoint (with a comment to preserve). */
const BEHAVIOR_YML = `schemaVersion: 1
# keep this owner comment
endpoints:
  - resourceId: ${ENDPOINT_ID}
    effects: []
    cases: []
    disposition:
      kind: out-of-scope
      reason: endpoint retired with the v1 API
      expiresAt: '${OLD_EXPIRY}'
      extensions:
        - at: '2025-12-20T00:00:00.000Z'
          by: owner
          reason: initial timer
          previousExpiresAt: '2025-12-25T00:00:00.000Z'
resources: []
`;

/** Fixture `.gateforge.yml`: fixed clock, both disposition surfaces. */
function configYml(withCoverageDisposition: boolean): string {
  return `schemaVersion: 1
project:
  languages: [javascript]
  paths:
    include: ['src/**']
    exclude: []
plugins: []
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['src/**']
  declarations:
    internality: gateforge:internal
  volatileFields: []
clock: { mode: fixed, fixedAt: '${NOW}' }
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
behaviorPolicy: .gateforge/behavior.yml
coveragePolicy:
  tables:
    - name: invoices
      requiredOperations: [create, read]
      disposition:${
        withCoverageDisposition
          ? `
        kind: not-user-facing
        expiresAt: '${OLD_EXPIRY}'
        extensions: []`
          : `
        kind: not-user-facing`
      }
`;
}

interface RepoPaths {
  config: string;
  behavior: string;
}

/** Installs the fixture documents into a temp repo. */
function installDispositionFixture(repo: TempRepo, withCoverageDisposition = true): RepoPaths {
  repo.writeFiles({
    '.gateforge.yml': configYml(withCoverageDisposition),
    '.gateforge/behavior.yml': BEHAVIOR_YML,
  });
  return { config: repo.path('.gateforge.yml'), behavior: repo.path('.gateforge/behavior.yml') };
}

interface BehaviorDoc {
  endpoints: Array<{
    resourceId: string;
    disposition?: {
      expiresAt?: string;
      extensions?: Array<{ at: string; by: string; reason: string; previousExpiresAt: string }>;
    };
  }>;
}

interface ConfigDoc {
  coveragePolicy?: {
    tables: Array<{
      name: string;
      disposition?: {
        expiresAt?: string;
        extensions?: Array<{ at: string; by: string; reason: string; previousExpiresAt: string }>;
      };
    }>;
  };
}

describe('gateforge disposition extend', () => {
  it('rewrites a behavior endpoint expiry, appends the audit entry, and preserves the document', async () => {
    await withTempRepo({}, async (repo) => {
      const paths = installDispositionFixture(repo);
      const result = await runCli(repo, [
        'disposition', 'extend', ENDPOINT_ID,
        '--expires', NEW_EXPIRY,
        '--owner', 'owner',
        '--reason', 'still unreachable',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`disposition extended: endpoint '${ENDPOINT_ID}'`);
      expect(result.stdout).toContain(`${OLD_EXPIRY} -> ${NEW_EXPIRY}`);
      expect(result.stdout).toContain('never pins and never approves a digest');
      expect(result.stdout).toContain('enforcement pin');

      const raw = readFileSync(paths.behavior, 'utf8');
      expect(raw).toContain('# keep this owner comment');
      const doc = parseYaml(raw) as BehaviorDoc;
      const disposition = doc.endpoints[0]?.disposition;
      expect(disposition?.expiresAt).toBe(NEW_EXPIRY);
      expect(disposition?.extensions).toHaveLength(2);
      expect(disposition?.extensions?.[1]).toEqual({
        at: NOW,
        by: 'owner',
        reason: 'still unreachable',
        previousExpiresAt: OLD_EXPIRY,
      });
    });
  });

  it('rewrites a coveragePolicy table expiry inside .gateforge.yml and leaves the rest alone', async () => {
    await withTempRepo({}, async (repo) => {
      const paths = installDispositionFixture(repo);
      const result = await runCli(repo, [
        'disposition', 'extend', 'invoices',
        '--expires', NEW_EXPIRY,
        '--owner', 'owner',
        '--reason', 'table still not user facing',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("disposition extended: table 'invoices'");

      const config = parseYaml(readFileSync(paths.config, 'utf8')) as ConfigDoc;
      const disposition = config.coveragePolicy?.tables[0]?.disposition;
      expect(disposition?.expiresAt).toBe(NEW_EXPIRY);
      expect(disposition?.extensions).toEqual([
        { at: NOW, by: 'owner', reason: 'table still not user facing', previousExpiresAt: OLD_EXPIRY },
      ]);

      const behavior = parseYaml(readFileSync(paths.behavior, 'utf8')) as BehaviorDoc;
      expect(behavior.endpoints[0]?.disposition?.expiresAt).toBe(OLD_EXPIRY);
    });
  });

  it('refuses an expiry further out than the configured maximum and writes nothing', async () => {
    await withTempRepo({}, async (repo) => {
      const paths = installDispositionFixture(repo);
      const before = readFileSync(paths.behavior, 'utf8');
      const result = await runCli(repo, [
        'disposition', 'extend', ENDPOINT_ID,
        '--expires', OVER_MAX_EXPIRY,
        '--owner', 'owner',
        '--reason', 'too long',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('maximum disposition duration');
      expect(result.stderr).toContain('disposition.maxDays');
      expect(readFileSync(paths.behavior, 'utf8')).toBe(before);
    });
  });

  it('refuses an unknown target and suggests the declared ones', async () => {
    await withTempRepo({}, async (repo) => {
      const paths = installDispositionFixture(repo);
      const before = readFileSync(paths.behavior, 'utf8');
      const result = await runCli(repo, [
        'disposition', 'extend', 'orders-endpoint',
        '--expires', NEW_EXPIRY,
        '--owner', 'owner',
        '--reason', 'typo',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("no endpoint or table named 'orders-endpoint'");
      expect(result.stderr).toContain(ENDPOINT_ID);
      expect(result.stderr).toContain('invoices');
      expect(readFileSync(paths.behavior, 'utf8')).toBe(before);
    });
  });

  it('refuses a disposition without a timer: there is no previous expiry to record', async () => {
    await withTempRepo({}, async (repo) => {
      const paths = installDispositionFixture(repo, false);
      const before = readFileSync(paths.config, 'utf8');
      const result = await runCli(repo, [
        'disposition', 'extend', 'invoices',
        '--expires', NEW_EXPIRY,
        '--owner', 'owner',
        '--reason', 'no timer yet',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('has no disposition `expiresAt` to extend');
      expect(readFileSync(paths.config, 'utf8')).toBe(before);
    });
  });
});
