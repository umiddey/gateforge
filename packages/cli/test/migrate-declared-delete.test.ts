/**
 * A DECLARED delete answer must survive `gateforge migrate` (0.11.0).
 *
 * `.gateforge/endpoints.json` may declare `crud-delete` / `crud-archive`
 * on a DELETE route, and that declaration is POSITIVE HUMAN EVIDENCE: it
 * resolves archive-vs-hard with no model declaration and with no linkage
 * at all. That last part is the whole reason the channel exists. A DELETE
 * route that links no business resource — a link-row teardown, a draft
 * discard, a cache purge — cannot be expressed in the owner's
 * `deleteRules`, which are keyed by a resource's source glob. Removing
 * the capability therefore did not "move" an answer, it DELETED one, and
 * a real repository carrying 29 such declarations could not even be
 * migrated: `migrate` validates every old value through the reader that
 * will read it after the move and refused
 *
 *   invalid endpoints config: rules[0].capability must be one of:
 *   'health-operations', ..., 'crud-update'
 *
 * before writing anything.
 *
 * Both arms below run the SAME engine, so comparing them proves the
 * migration preserved the declaration. The comparison is only meaningful
 * because the third case shows the answer is LOAD-BEARING: with the
 * `endpoints:` section removed these two DELETEs have no positive
 * evidence at all and stay unresolved.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_ANSWERS_PATH, withTempRepo, type TempRepo } from '@gate-forge/core';
import { parse as parseYaml } from 'yaml';
import { runCli } from './helpers.js';

const SCAN_ROOTS = "['web/**/*.js']";

/**
 * Two DELETE routes and NO models, so nothing can link: the declared
 * answer is the only evidence either route will ever have.
 */
const SERVER = `import express from 'express';

const app = express();

app.delete('/api/v1/invitations/:invitation_id', (_req, res) => res.status(204).end());
app.delete('/api/v1/drafts/:draft_id', (_req, res) => res.status(204).end());

export default app;
`;

/** The two reviewed rules, in the shape the old JSON file carried. */
const ENDPOINT_RULES = [
  {
    paths: ['/api/v1/invitations/**'],
    method: 'DELETE',
    capability: 'crud-delete',
    reason: 'The row is removed; the session leaves no tombstone.',
  },
  {
    paths: ['/api/v1/drafts/**'],
    method: 'DELETE',
    capability: 'crud-archive',
    reason: 'The handler sets archived_at; the draft is never removed.',
  },
] as const;

const PRE_MIGRATION_ENDPOINTS = `${JSON.stringify({ rules: ENDPOINT_RULES }, null, 2)}\n`;

/** The same two rules as the `endpoints:` section of the answers document. */
const ENDPOINTS_SECTION = `\
endpoints:
  rules:
    - paths:
        - /api/v1/invitations/**
      method: DELETE
      capability: crud-delete
      reason: The row is removed; the session leaves no tombstone.
    - paths:
        - /api/v1/drafts/**
      method: DELETE
      capability: crud-archive
      reason: The handler sets archived_at; the draft is never removed.
`;

const PRE_MIGRATION_ANSWERS = `\
# Owner answers. The reasons below ARE the review record.
schemaVersion: 1
scanRoots: ${SCAN_ROOTS}
declarations: {}
volatileFields: []
trustedInternalEntryPoints: []
internalRules: []
`;

const MIGRATED_ANSWERS = `\
# Owner answers. The reasons below ARE the review record.
schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
${ENDPOINTS_SECTION}`;

/** `.gateforge.yml` as 0.10.x left it: no `scan:`, the keys were in the answers. */
const PRE_MIGRATION_CONFIG_YML = `\
schemaVersion: 1
project:
  languages: [js]
  paths:
    include: ${SCAN_ROOTS}
    exclude: []
plugins:
  - id: gateforge.pack-http
    version: '0.1.0'
    transport: in-process
    module: '@gate-forge/pack-http'
policies: .gateforge/policies.yml
classificationPolicy: ${OWNER_ANSWERS_PATH}
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`;

/** The same repository in 0.11 shape, written the way an owner would. */
const MIGRATED_CONFIG_YML = `\
${PRE_MIGRATION_CONFIG_YML.slice(0, PRE_MIGRATION_CONFIG_YML.indexOf('changed:'))}scan:
  scanRoots: ${SCAN_ROOTS}
  declarations: {}
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`;

const POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: user-facing-crud
    when:
      exposure: user-facing
    require:
      - persistence:read
`;

/** The non-owner files, identical in every arm. */
function sharedFiles(): Record<string, string> {
  return {
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge/policies.yml': POLICIES_YML,
    'web/server.js': SERVER,
  };
}

/**
 * @param repo the temp repository under test
 */
function preMigrationRepo(repo: TempRepo): void {
  repo.writeFiles({
    ...sharedFiles(),
    '.gateforge.yml': PRE_MIGRATION_CONFIG_YML,
    [OWNER_ANSWERS_PATH]: PRE_MIGRATION_ANSWERS,

    '.gateforge/endpoints.json': PRE_MIGRATION_ENDPOINTS,
  });
}

/**
 * @param repo the temp repository under test
 * @param withSection false writes the 0.11 repo WITHOUT the `endpoints:`
 *   section, i.e. the repository a route with no declaration has.
 */
function migratedRepo(repo: TempRepo, { withSection = true }: { withSection?: boolean } = {}): void {
  repo.writeFiles({
    ...sharedFiles(),
    '.gateforge.yml': MIGRATED_CONFIG_YML,
    [OWNER_ANSWERS_PATH]: withSection ? MIGRATED_ANSWERS : PRE_MIGRATION_ANSWERS.replace(/^scanRoots:.*\n/m, '').replace(/^declarations:.*\n/m, '').replace(/^volatileFields:.*\n/m, ''),
  });
}

/** The parsed answers document; `endpoints:` is the section the move writes. */
function readAnswers(repo: TempRepo): { endpoints?: unknown } {
  const parsed: unknown = parseYaml(
    readFileSync(join(repo.root, ...OWNER_ANSWERS_PATH.split('/')), 'utf8'),
  );
  return parsed !== null && typeof parsed === 'object' ? { ...parsed } : {};
}

/** The `check --format json` fields that answer "what did the run conclude". */
function gradedOf(stdout: string): Record<string, unknown> {
  const report = JSON.parse(stdout) as Record<string, unknown>;
  return {
    summary: report['summary'],
    blocking: report['blocking'],
    verdicts: report['verdicts'],
    scope: report['scope'],
  };
}

/** The `capabilities=` value the endpoint inventory reports for one path. */
function capabilitiesForPath(text: string, path: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.includes(path)) continue;
    const match = /\s+capabilities=(\S+)/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

describe('a declared crud-delete/crud-archive survives gateforge migrate', () => {
  it('grades the migrated repository exactly as the hand-written 0.11 one', async () => {
    await withTempRepo({}, async (handWritten) => {
      await withTempRepo({}, async (migrated) => {
        migratedRepo(handWritten);
        preMigrationRepo(migrated);

        // Before 0.11.0's restoration this refused with "invalid endpoints
        // config: rules[0].capability must be one of: ...".
        const applied = await runCli(migrated, ['migrate', '--confirm']);
        expect(applied.code, `${applied.stdout}\n${applied.stderr}`).toBe(0);

        // The two arms really are the same repository: the migration wrote
        // the same `endpoints:` section the hand-written one declares.
        expect(readAnswers(migrated).endpoints).toEqual(readAnswers(handWritten).endpoints);

        const before = await runCli(handWritten, ['check', '--format', 'json']);
        const after = await runCli(migrated, ['check', '--format', 'json']);
        expect(after.code, after.stderr).toBe(before.code);
        expect(gradedOf(after.stdout)).toEqual(gradedOf(before.stdout));
      });
    });
  }, 300_000);

  it('is load-bearing: the two unlinked DELETEs are unresolved without it', async () => {
    await withTempRepo({}, async (declared) => {
      await withTempRepo({}, async (undeclared) => {
        migratedRepo(declared);
        migratedRepo(undeclared, { withSection: false });

        // No model links either route, so the declaration is the ONLY
        // positive evidence these DELETEs can ever have.
        const withAnswer = await runCli(declared, ['check']);
        expect(capabilitiesForPath(withAnswer.stdout, '/api/v1/invitations'), withAnswer.stdout).toBe(
          'crud-delete',
        );
        expect(capabilitiesForPath(withAnswer.stdout, '/api/v1/drafts'), withAnswer.stdout).toBe(
          'crud-archive',
        );

        const withoutAnswer = await runCli(undeclared, ['check']);
        expect(capabilitiesForPath(withoutAnswer.stdout, '/api/v1/invitations'), withoutAnswer.stdout).toBe(
          '<unresolved>',
        );
        expect(capabilitiesForPath(withoutAnswer.stdout, '/api/v1/drafts'), withoutAnswer.stdout).toBe(
          '<unresolved>',
        );
      });
    });
  }, 300_000);
});
