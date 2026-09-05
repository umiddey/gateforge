/**
 * Trusted evidence primitives (plan §5.3, invariant 6, GF-22).
 *
 * The fixture exposes EXACTLY five surfaces — `ui`, `visible`,
 * `persistence`, `http`, `finalize` — on a frozen object with a
 * closure-private record list. There is no boolean/escape-hatch primitive (no
 * `prove(kind, true)`), no way to state an entity id for persistence
 * evidence, and no way to substitute an adapter: persistence evidence is
 * minted ONLY by the engine-side witness running the reviewed adapter
 * (GET-only), stamped from the ADAPTER RESPONSE.
 *
 * UI primitives drive the RENDERED app (create/read/update/archive) and
 * read the visible result back from the DOM, so the entityId in a
 * `ui.action` record is observed, not declared. Receipts returned by UI
 * primitives are frozen and branded with a per-instance symbol —
 * `visible.confirm`/`persistence.verify` reject anything without the
 * own-property brand (GF-22: hand-rolled or `Object.create`-branded
 * forgeries fail closed).
 *
 * Every record is submitted to the loopback witness service under EVERY
 * claim the test declares (one obligation id per annotation); the
 * witness issues service provenance, and the ENGINE decides verdicts —
 * never the test. A test using primitives but declaring no claim, or a
 * claim whose evidence was never collected, fails `finalize()` (the
 * gate would grade the claim `missing` anyway; finalize mirrors that
 * fail-fast in the test).
 */
import type { Locator, Page, TestInfo } from 'playwright/test';
import {
  CLAIM_ANNOTATION_TYPE,
  ENV_APP_BASE_URL,
  ENV_TARGET_BASE_URL,
  UI_ACTION_KIND,
  UI_VISIBLE_RESULT_KIND,
} from '../constants.js';
import { WitnessClient } from './witness-client.js';

/** A UI-action receipt: the ONLY token `visible`/`persistence` accept. */
export interface Receipt {
  readonly kind: 'ui';
  readonly operation: 'create' | 'read' | 'update' | 'delete';
  readonly resourceId: string;
  readonly entityId: string;
  readonly fields: Record<string, string>;
  readonly mode: 'row' | 'form';
  /**
   * Create only: the engine-side pre-observation taken BEFORE the UI
   * action, bound into the persistence record so the engine can verify
   * the entity was absent before (create postcondition, audit round 4).
   */
  readonly preObservationId?: string;
}

/** Outcome of `persistence.verify` (verdict-relevant, witness-issued). */
export interface PersistenceOutcome {
  recordId: string;
  runId: string;
  verdictRelevant: {
    found: boolean;
    fieldsMatch: boolean;
    mismatches?: string[];
  };
}

/** The frozen, no-escape-hatch evidence surface. */
export interface EvidenceApi {
  readonly ui: Readonly<{
    create(input: { fields: { first_name: string; last_name: string } }): Promise<Receipt>;
    read(input: { entityId: string }): Promise<Receipt>;
    update(input: { entityId: string; fields: Partial<{ first_name: string; last_name: string }> }): Promise<Receipt>;
    archive(input: { entityId: string }): Promise<Receipt>;
  }>;
  readonly visible: Readonly<{
    confirm(receipt: Receipt): Promise<{ entityId: string; fields: Record<string, string> }>;
  }>;
  readonly persistence: Readonly<{
    verify(receipt: Receipt): Promise<PersistenceOutcome>;
  }>;
  /** ADR 0004 D7: consumes one proxy-observed request for an http:* claim. */
  http: Readonly<{
    observe(request: { method: string; path: string }): Promise<{
      status: number;
      recordId: string;
      recordIds: string[];
    }>;
  }>;
  finalize(): Promise<{ claims: string[]; records: WitnessRecord[] }>;
}

/** One witness-issued record as the finalize ledger reports it. */
export interface WitnessRecord {
  recordId: string;
  runId: string;
  obligationId: string;
  kind: string;
  payload: unknown;
}

/** Receipt branding: per-instance symbol, own-property checked (GF-22). */
function makeReceiptBrand() {
  const token = Symbol('gateforge.receipt');
  return {
    stamp(receipt: Omit<Receipt, 'kind'>): Receipt {
      return Object.freeze({ ...receipt, kind: 'ui', [token]: true } as unknown as Receipt);
    },
    isGenuine(receipt: unknown): receipt is Receipt {
      return (
        receipt !== null &&
        typeof receipt === 'object' &&
        Object.prototype.hasOwnProperty.call(receipt, token) &&
        (receipt as Record<symbol, unknown>)[token] === true
      );
    },
  };
}

/** Claims from the test annotations (`{type: 'gateforge', description}`). */
export function claimsFromAnnotations(
  annotations: readonly { type: string; description?: string }[],
): string[] {
  return annotations
    .filter((annotation) => annotation.type === CLAIM_ANNOTATION_TYPE)
    .map((annotation) => annotation.description ?? '')
    .filter((description) => description.length > 0);
}

/** Splits `<resourceId>:<contract>` at the first colon. */
export function resourceIdOfClaim(claim: string): string {
  const colon = claim.indexOf(':');
  return colon === -1 ? claim : claim.slice(0, colon);
}

/**
 * Creates the evidence API for one test.
 *
 * Args:
 *   page: the test's page (the primitives drive the rendered UI on it).
 *   testInfo: the running test's info (annotations + testId).
 *   baseURL: the app-under-test base; defaults to GATEFORGE_APP_BASE_URL
 *     then GATEFORGE_TARGET_BASE_URL.
 *   client: witness transport override (tests inject their own).
 *
 * Returns:
 *   EvidenceApi: the frozen primitive surface.
 *
 * Throws:
 *   Error: when the test declares no gateforge claim, when no app base
 *   or witness is wired, or when an action/verification fails fail-closed.
 */
export function createEvidence({
  page,
  testInfo,
  baseURL,
  client,
}: {
  page: Page;
  testInfo: TestInfo;
  baseURL?: string;
  client?: WitnessClient;
}): EvidenceApi {
  const claims = claimsFromAnnotations(testInfo.annotations);
  if (claims.length === 0) {
    throw new Error(
      `test '${testInfo.title}' uses gateforge evidence primitives but declares no ` +
        `'${CLAIM_ANNOTATION_TYPE}' annotation carrying the claimed obligation id`,
    );
  }
  const appBase = baseURL ?? process.env[ENV_APP_BASE_URL] ?? process.env[ENV_TARGET_BASE_URL];
  if (appBase === undefined || appBase === '') {
    throw new Error(
      `no app-under-test base is wired: set ${ENV_APP_BASE_URL} (or ${ENV_TARGET_BASE_URL}) ` +
        'so UI primitives can drive the rendered app',
    );
  }
  const witness = client ?? new WitnessClient();
  const testId = testInfo.testId;
  const receiptBrand = makeReceiptBrand();

  async function submit(kind: string, payload: unknown): Promise<void> {
    for (const claim of claims) {
      await witness.postRecords({ claimId: claim, kind, payload, testId });
    }
  }

  // ---------- DOM helpers for the rendered example app ----------

  async function gotoList(): Promise<void> {
    await page.goto(`${appBase}/`);
    await page.waitForSelector('h1:has-text("Accounts")');
  }

  async function collectIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const rows = page.locator('tbody tr');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const text = (await rows.nth(i).locator('td').first().textContent())?.trim() ?? '';
      if (text !== '') ids.add(text);
    }
    return ids;
  }

  async function findRow(entityId: string): Promise<Locator | null> {
    const rows = page.locator('tbody tr');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if (((await row.locator('td').first().textContent())?.trim() ?? '') === entityId) return row;
    }
    return null;
  }

  async function readRowFields(row: Locator): Promise<Record<string, string>> {
    const cells = row.locator('td');
    const text = (index: number) =>
      cells.nth(index).textContent().then((t) => (t ?? '').trim());
    return { first_name: await text(1), last_name: await text(2), status: await text(3) };
  }

  async function readFormFields(): Promise<Record<string, string>> {
    return {
      first_name: await page.locator('input[name="first_name"]').inputValue(),
      last_name: await page.locator('input[name="last_name"]').inputValue(),
    };
  }

  async function waitListAfterAction(): Promise<void> {
    await page.waitForURL((url) => url.pathname === '/');
    await page.waitForSelector('h1:has-text("Accounts")');
  }

  // ---------- UI primitives (plan §5.3 step 1) ----------

  const ui = {
    async create(input: { fields: { first_name: string; last_name: string } }): Promise<Receipt> {
      const { first_name, last_name } = input.fields;
      if (!first_name || !last_name) {
        throw new Error('ui.create requires { fields: { first_name, last_name } }');
      }
      const resourceId = resourceIdOfClaim(claims[0] as string);
      // Engine-side pre-observation BEFORE the action (audit rounds 4-5):
      // the witness snapshots the observed id set so the persistence
      // record can prove the entity was absent before the create.
      const preObservation = await witness.preObserve({
        resourceId,
        testId,
        claimId: claims[0] as string,
      });
      await gotoList();
      const before = await collectIds();
      await page.goto(`${appBase}/accounts/new`);
      await page.waitForSelector('form[action="/accounts"]');
      await page.locator('input[name="first_name"]').fill(first_name);
      await page.locator('input[name="last_name"]').fill(last_name);
      await page.locator('button[type="submit"]').click();
      await waitListAfterAction();
      const created = [...(await collectIds())].filter((id) => !before.has(id));
      if (created.length !== 1) {
        throw new Error(`ui.create expected exactly one new entity, saw ${created.length}`);
      }
      const entityId = created[0] as string;
      const row = await findRow(entityId);
      if (row === null) throw new Error(`ui.create: rendered UI shows no row for ${entityId}`);
      const visible = await readRowFields(row);
      if (visible.status !== 'active') {
        throw new Error(`ui.create: created entity ${entityId} rendered with status '${visible.status}'`);
      }
      const fields = { first_name: visible['first_name'] ?? '', last_name: visible['last_name'] ?? '' };
      await submit(UI_ACTION_KIND, { operation: 'create', entityId, fields });
      return receiptBrand.stamp({
        operation: 'create',
        resourceId,
        entityId,
        fields,
        mode: 'row',
        preObservationId: preObservation.observationId,
      });
    },

    async read(input: { entityId: string }): Promise<Receipt> {
      const { entityId } = input;
      if (!entityId) throw new Error('ui.read requires { entityId }');
      const resourceId = resourceIdOfClaim(claims[0] as string);
      await gotoList();
      const row = await findRow(entityId);
      if (row === null) {
        throw new Error(`ui.read: rendered UI exposes no row for entity ${entityId}`);
      }
      const edit = row.locator('a[href$="/edit"]');
      if ((await edit.count()) === 0) {
        throw new Error(`ui.read: rendered UI exposes no navigation control for entity ${entityId}`);
      }
      await edit.click();
      await page.waitForSelector(`form[action="/accounts/${entityId}"]`);
      const fields = await readFormFields();
      await submit(UI_ACTION_KIND, { operation: 'read', entityId, fields });
      return receiptBrand.stamp({ operation: 'read', resourceId, entityId, fields, mode: 'form' });
    },

    async update(
      input: { entityId: string; fields: Partial<{ first_name: string; last_name: string }> },
    ): Promise<Receipt> {
      const { entityId, fields } = input;
      if (!entityId || typeof fields !== 'object' || fields === null) {
        throw new Error('ui.update requires { entityId, fields }');
      }
      const resourceId = resourceIdOfClaim(claims[0] as string);
      // Engine-side entity pre-observation BEFORE the change (audit
      // rounds 4-5): the witness snapshots the observed fields so the
      // persistence record can prove an actual before/after delta.
      const preObservation = await witness.preObserve({
        resourceId,
        testId,
        claimId: claims[0] as string,
        entityId,
      });
      await gotoList();
      const row = await findRow(entityId);
      if (row === null) {
        throw new Error(`ui.update: rendered UI exposes no row for entity ${entityId}`);
      }
      await row.locator('a[href$="/edit"]').click();
      await page.waitForSelector(`form[action="/accounts/${entityId}"]`);
      if (fields.first_name !== undefined) await page.locator('input[name="first_name"]').fill(fields.first_name);
      if (fields.last_name !== undefined) await page.locator('input[name="last_name"]').fill(fields.last_name);
      // The edit page renders TWO submit buttons (save + archive);
      // scope to the edit form's own save control.
      await page.locator(`form[action="/accounts/${entityId}"] button:not([formaction])`).first().click();
      await waitListAfterAction();
      const updatedRow = await findRow(entityId);
      if (updatedRow === null) {
        throw new Error(`ui.update: entity ${entityId} vanished after update`);
      }
      const declared = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      ) as Record<string, string>;
      await submit(UI_ACTION_KIND, { operation: 'update', entityId, fields: declared });
      void (await readRowFields(updatedRow)); // observed; the engine judges agreement
      return receiptBrand.stamp({
        operation: 'update',
        resourceId,
        entityId,
        fields: declared,
        mode: 'row',
        preObservationId: preObservation.observationId,
      });
    },

    async archive(input: { entityId: string }): Promise<Receipt> {
      const { entityId } = input;
      if (!entityId) throw new Error('ui.archive requires { entityId }');
      const resourceId = resourceIdOfClaim(claims[0] as string);
      await gotoList();
      const row = await findRow(entityId);
      if (row === null) {
        throw new Error(`ui.archive: rendered UI exposes no row for entity ${entityId}`);
      }
      const control = row.locator(`form[action="/accounts/${entityId}/archive"] button`);
      if ((await control.count()) === 0) {
        throw new Error(`ui.archive: entity ${entityId} is already archived (no archive control rendered)`);
      }
      await control.click();
      await waitListAfterAction();
      const archivedRow = await findRow(entityId);
      if (archivedRow === null) {
        throw new Error(`ui.archive: entity ${entityId} vanished after archive`);
      }
      const visible = await readRowFields(archivedRow);
      if (visible.status !== 'archived') {
        throw new Error(`ui.archive: entity ${entityId} rendered status '${visible.status}', expected 'archived'`);
      }
      const fields = { status: 'archived' };
      await submit(UI_ACTION_KIND, { operation: 'delete', entityId, fields });
      return receiptBrand.stamp({ operation: 'delete', resourceId, entityId, fields, mode: 'row' });
    },
  };

  // ---------- visible-result primitive (plan §5.3 step 2) ----------

  const visible = {
    async confirm(receipt: Receipt): Promise<{ entityId: string; fields: Record<string, string> }> {
      if (!receiptBrand.isGenuine(receipt)) {
        throw new Error(
          'visible.confirm requires a receipt issued by an evidence.ui primitive ' +
            '(hand-rolled objects are rejected — GF-22)',
        );
      }
      const fields =
        receipt.mode === 'row'
          ? await readRowFields((await requireRow(receipt.entityId))!)
          : await readFormOn(receipt.entityId);
      await submit(UI_VISIBLE_RESULT_KIND, { entityId: receipt.entityId, fields });
      return { entityId: receipt.entityId, fields };
    },
  };

  async function requireRow(entityId: string): Promise<Locator> {
    const row = await findRow(entityId);
    if (row === null) {
      throw new Error(`visible.confirm: rendered UI exposes no row for entity ${entityId}`);
    }
    return row;
  }

  async function readFormOn(entityId: string): Promise<Record<string, string>> {
    await page.waitForSelector(`form[action="/accounts/${entityId}"]`);
    return readFormFields();
  }

  // ---------- persistence primitive (plan §5.3 steps 3-4) ----------

  const persistence = {
    async verify(receipt: Receipt): Promise<PersistenceOutcome> {
      if (!receiptBrand.isGenuine(receipt)) {
        throw new Error(
          'persistence.verify requires a receipt issued by an evidence.ui primitive ' +
            '(hand-rolled objects are rejected — GF-22)',
        );
      }
      const response = await witness.verifyPersistence({
        resourceId: receipt.resourceId,
        entityId: receipt.entityId,
        testId,
        claimId: claims[0] as string,
        ...(receipt.preObservationId !== undefined
          ? { preObservationId: receipt.preObservationId }
          : {}),
      });
      return {
        recordId: response.recordId,
        runId: response.runId,
        verdictRelevant: response.verdictRelevant,
      };
    },
  };

  // ---------- http observation (ADR 0004 D7) ----------
  // Consumes one witness-proxy observation for the browser request the
  // journey caused and binds the witnessed `http.request` record to the
  // declared http:* obligation claims. Without real proxied traffic the
  // witness answers 409 — the suite cannot mint network evidence.

  async function observeHttp(request: {
    method: string;
    path: string;
  }): Promise<{ status: number; recordId: string; recordIds: string[] }> {
    const httpClaims = claims.filter((claim) => claim.includes(':http:'));
    const targets = httpClaims.length > 0 ? httpClaims : claims;
    const result = await witness.observeHttp({
      claimIds: [...targets],
      testId,
      method: request.method.toUpperCase(),
      path: request.path,
    });
    return {
      status: result.status,
      recordId: result.records[0]?.recordId ?? '',
      recordIds: result.records.map((record) => record.recordId),
    };
  }

  // ---------- finalize (fail-fast + ledger cross-check) ----------

  async function finalize(): Promise<{ claims: string[]; records: WitnessRecord[] }> {
    const ledger = await witness.listRecords();
    const mine = ledger.records.filter(
      (record) => (record as { testId?: unknown })['testId'] === testId,
    );
    for (const claim of claims) {
      const count = mine.filter(
        (record) => (record as { obligationId?: unknown })['obligationId'] === claim,
      ).length;
      if (count === 0) {
        throw new Error(
          `claim '${claim}' produced no witness records (finalize fail-fast; the gate would grade it missing)`,
        );
      }
    }
    const records: WitnessRecord[] = mine.map((record) => {
      const entry = record as unknown as Record<string, unknown>;
      return {
        recordId: String(entry['recordId'] ?? ''),
        runId: String(entry['runId'] ?? ''),
        obligationId: String(entry['obligationId'] ?? ''),
        kind: String(entry['kind'] ?? ''),
        payload: entry['payload'],
      };
    });
    return { claims: [...claims], records };
  }

  // Freeze the surface: no method can be added/replaced from the test;
  // the transcript stays closure-private (no escape hatch, invariant 6).
  return Object.freeze({
    ui: Object.freeze(ui),
    visible: Object.freeze(visible),
    persistence: Object.freeze(persistence),
    http: Object.freeze({ observe: observeHttp }),
    finalize,
  });
}