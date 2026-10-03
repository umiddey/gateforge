/**
 * Twin path coverage (E64), witness side: a raw twin may be OBSERVED and
 * may submit nothing.
 *
 * The trap this pins is an identity one. The supervisor enumerated the
 * suite from the repository's own Playwright config, so it holds a
 * `testId` like `specs/items.spec.js#lists open items raw`; the run
 * itself is supervised through a TRUSTED config whose testDir is the
 * repository root, so the test it runs under is addressed by a hashed
 * id (`a5f721c4f4aadf2db7d6-…`). Both are the same test. A mark
 * carried by the enumerated id would never match the session the run
 * opened, and the raw twin would be marked nothing — quietly free to
 * issue records.
 *
 * So the mark travels with the registration's identity (project, file,
 * titlePath), and this proves it end to end against a real witness:
 * the observation-only session is refused every submission, and the
 * witnessed twin's session is not.
 */
import { describe, expect, it } from 'vitest';
import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { SupervisorClient } from '../../pack-playwright/src/supervisor/client.js';
import { WitnessClient, WitnessRequestError } from '../../witness/src/client/witness-client.js';

const RUN_ID = '9f1d4c2a-6b7e-4d5a-9c3f-2b8e1a0d7c64';
const TOKEN = 'twin-observation-suite-token';
const VERIFIER_KEY = 'twin-observation-verifier-key';
const FILE = 'specs/items.spec.js';
const WITNESSED_TITLE = ['lists open items [witnessed]'];
const RAW_TITLE = ['lists open items raw'];
/** The id the repository's own config enumerates. */
const CATALOG_ID = `${FILE}#lists open items raw`;
/** The id the supervised run actually runs the test under. */
const RUNTIME_ID = 'a5f721c4f4aadf2db7d6-2f8a1c93b7e0';

describe('twin path coverage (E64): a raw twin is observed and issues nothing', () => {
  it('refuses every submission from the marked session, and only from it', async () => {
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY });
    const supervisor = new SupervisorClient(witness.url, TOKEN, VERIFIER_KEY);
    await supervisor.registerExpectedSet({
      tests: [
        {
          testId: CATALOG_ID,
          project: 'chromium',
          file: FILE,
          titlePath: WITNESSED_TITLE,
        },
        {
          testId: CATALOG_ID,
          project: 'chromium',
          file: FILE,
          titlePath: RAW_TITLE,
          observationOnly: true,
        },
      ],
    });
    const raw = await supervisor.openSession({
      testId: RUNTIME_ID,
      workerIndex: 0,
      file: FILE,
      titlePath: RAW_TITLE,
      project: 'chromium',
    });
    const witnessed = await supervisor.openSession({
      testId: RUNTIME_ID,
      workerIndex: 1,
      file: FILE,
      titlePath: WITNESSED_TITLE,
      project: 'chromium',
    });
    // The session answers with the id the RUN used, while the mark came
    // from the id the ENUMERATION held: the two are not the same, and
    // the mark still landed.
    expect(raw.testId).toBe(RUNTIME_ID);

    const suite = new WitnessClient(witness.url, TOKEN);
    let refusal = '';
    try {
      await suite.observeHttp({
        testId: RUNTIME_ID,
        method: 'GET',
        path: '/api/items',
        claimId: 'tenant.accounts:crud:create',
        sessionId: raw.sessionId,
        sessionToken: raw.sessionToken,
      });
    } catch (error) {
      refusal = error instanceof WitnessRequestError ? `${String(error.status)} ${error.message}` : String(error);
    }
    // Refused, with a reason that says what the session is FOR — and
    // with no record id anywhere in the answer.
    expect(refusal).toContain('403');
    expect(refusal).toContain('OBSERVATION-ONLY');
    expect(refusal).not.toMatch(/recordId/);

    // The witnessed twin's session is NOT behind that gate: it gets
    // past it and fails later, on the observation it never made.
    let witnessedError = '';
    try {
      await suite.observeHttp({
        testId: RUNTIME_ID,
        method: 'GET',
        path: '/api/items',
        claimId: 'tenant.accounts:crud:create',
        sessionId: witnessed.sessionId,
        sessionToken: witnessed.sessionToken,
      });
    } catch (error) {
      witnessedError = error instanceof WitnessRequestError ? `${String(error.status)} ${error.message}` : String(error);
    }
    expect(witnessedError).not.toContain('OBSERVATION-ONLY');

    await witness.stop();
  }, 60_000);
});
