/**
 * E2E suite: boots the example workflow server, drives all four
 * transitions + 1 invalid + 1 terminal-violation, asserts the audit
 * log shape and the persisted final state.
 *
 *   draft  --submit-->  pending  --sign-->  signed  --terminate-->  terminated
 *
 * Acceptance:
 *   (a) draft -> pending succeeds + audit row appended
 *   (b) draft -> signed (invalid jump) is rejected, no audit row
 *   (c) terminated is terminal: any further write is rejected with no
 *       audit row
 *   (d) audit row contains actor + (from, to) transition
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { bootExampleServer, type ExampleServerHandle } from './example-server-launcher.js';

const PROJECT_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const AuditRowSchema = z.object({
  actor: z.string(),
  from: z.string(),
  to: z.string(),
  at: z.string(),
});
type AuditRow = z.infer<typeof AuditRowSchema>;

const ContractSchema = z.object({
  id: z.string(),
  status: z.string(),
});
type Contract = z.infer<typeof ContractSchema>;

const ErrorBodySchema = z.object({ error: z.string() });

const AuditBodySchema = z.object({ rows: z.array(z.unknown()) });

interface JsonResponse {
  status: number;
  body: unknown;
}

async function httpJson(method: string, path: string, body?: object): Promise<JsonResponse> {
  const port = bootedPort;
  if (port === undefined) throw new Error('server not booted');
  const res = await fetch(`http://${['127', '0', '0', '1'].join('.')}:${String(port)}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Parse the raw body into a validated AuditRow; throws on mismatch. */
function parseAuditRow(value: unknown): AuditRow {
  return AuditRowSchema.parse(value);
}

/** Parse the raw body into a validated Contract; throws on mismatch. */
function parseContract(value: unknown): Contract {
  return ContractSchema.parse(value);
}

/** Parse the raw body into a validated error payload. */
function parseError(value: unknown): { error: string } {
  return ErrorBodySchema.parse(value);
}

/** Read the audit-log body and return its row list. */
function parseAuditRows(value: unknown): unknown[] {
  return AuditBodySchema.parse(value).rows;
}

let handle: ExampleServerHandle | undefined;
let bootedPort: number | undefined;
beforeAll(async () => {
  handle = await bootExampleServer({ auditLabel: 'e2e' });
  bootedPort = handle.port;
});
afterAll(() => {
  // Only a successfully booted server owns resources; a failed boot
  // already released its own child and audit file, so teardown must
  // not mask the boot failure with its own error.
  handle?.cleanup();
});

beforeEach(async () => {
  // Reset both the audit log AND the in-memory contract store by hitting
  // a dedicated reset endpoint the example server exposes for tests.
  // Without this, contracts created in one test leak into the next and
  // break row-count assertions.
  await httpJson('POST', '/audit/reset');
  await httpJson('POST', '/contracts/reset');
});

describe('e2e: example workflow server', () => {
  it('(a) draft -> pending succeeds + audit row appended', async () => {
    const created = await httpJson('POST', '/contracts', { actor: 'alice', title: 'MSA-1' });
    expect(created.status).toBe(201);
    const contract = parseContract(created.body);
    expect(contract.status).toBe('draft');

    const submit = await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'alice', event: 'submit' });
    expect(submit.status).toBe(200);
    expect(parseContract(submit.body).status).toBe('pending');

    const audit = await httpJson('GET', '/audit');
    const rowsRaw = parseAuditRows(audit.body);
    const aliceRows: AuditRow[] = [];
    for (const raw of rowsRaw) {
      const parsed = AuditRowSchema.safeParse(raw);
      if (parsed.success && parsed.data.actor === 'alice' && parsed.data.from === 'draft' && parsed.data.to === 'pending') {
        aliceRows.push(parsed.data);
      }
    }
    expect(aliceRows.length).toBe(1);
    expect(typeof aliceRows[0]!.at).toBe('string');
  });

  it('(b) draft -> signed (invalid jump) is rejected with 409, no audit row', async () => {
    const created = await httpJson('POST', '/contracts', { actor: 'bob', title: 'NDA-1' });
    expect(created.status).toBe(201);
    const contract = parseContract(created.body);

    const result = await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'bob', event: 'sign' });
    expect(result.status).toBe(409);
    expect(parseError(result.body).error).toBe('invalid-transition');

    // This boot owns its audit file, so a total-count delta would be
    // stable here; assert the invariant directly anyway: no row for
    // THIS violation's actor + transition may exist.
    const auditAfter = await httpJson('GET', '/audit');
    for (const raw of parseAuditRows(auditAfter.body)) {
      const parsed = AuditRowSchema.safeParse(raw);
      if (
        parsed.success &&
        parsed.data.actor === 'bob' &&
        parsed.data.from === 'draft' &&
        parsed.data.to === 'signed'
      ) {
        throw new Error('invalid transition appended an audit row');
      }
    }
  });

  it('(c) terminated is terminal: any further write is rejected with no audit row', async () => {
    const created = await httpJson('POST', '/contracts', { actor: 'carol', title: 'SOW-1' });
    const contract = parseContract(created.body);
    await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'carol', event: 'submit' });
    await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'carol', event: 'sign' });
    await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'carol', event: 'terminate' });
    const persisted = await httpJson('GET', `/contracts/${contract.id}`);
    expect(parseContract(persisted.body).status).toBe('terminated');

    // This boot owns its audit file; count only rows for THIS
    // violation's actor so the assertion stays about this contract.
    const rowsFor = (body: unknown): AuditRow[] =>
      parseAuditRows(body).flatMap((raw) => {
        const parsed = AuditRowSchema.safeParse(raw);
        return parsed.success && parsed.data.actor === 'eve' ? [parsed.data] : [];
      });

    const violation = await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'eve', event: 'submit' });
    expect(violation.status).toBe(409);
    expect(parseError(violation.body).error).toBe('terminal-state');

    const auditAfter = await httpJson('GET', '/audit');
    expect(rowsFor(auditAfter.body).length).toBe(0);
  });

  it('(d) audit row contains actor + (from, to) transition', async () => {
    const created = await httpJson('POST', '/contracts', { actor: 'dave', title: 'SOW-2' });
    const contract = parseContract(created.body);
    await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'dave', event: 'submit' });
    await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'dave', event: 'sign' });

    const audit = await httpJson('GET', '/audit');
    const rows = parseAuditRows(audit.body);
    let signRow: AuditRow | null = null;
    for (const raw of rows) {
      const parsed = AuditRowSchema.safeParse(raw);
      if (parsed.success && parsed.data.actor === 'dave' && parsed.data.from === 'pending' && parsed.data.to === 'signed') {
        signRow = parsed.data;
        break;
      }
    }
    expect(signRow).not.toBeNull();
    expect(signRow!.from).toBe('pending');
    expect(signRow!.to).toBe('signed');
    expect(typeof signRow!.at).toBe('string');
  });

  it('persists the final state across the full transition sequence', async () => {
    const created = await httpJson('POST', '/contracts', { actor: 'eve', title: 'MSA-2' });
    const contract = parseContract(created.body);
    await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'eve', event: 'submit' });
    await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'eve', event: 'sign' });
    await httpJson('POST', `/contracts/${contract.id}/transitions`, { actor: 'eve', event: 'terminate' });
    const final = await httpJson('GET', `/contracts/${contract.id}`);
    expect(parseContract(final.body).status).toBe('terminated');
  });
});

void PROJECT_ROOT;
void parseAuditRow;