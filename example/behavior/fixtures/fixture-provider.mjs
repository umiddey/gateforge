/**
 * Approved fixture/actor provider for the behavior reference app
 * (plan 2026-09-25, the production bind): a plain module the operator
 * points `GATEFORGE_FIXTURE_PROVIDER` at. The witness loads it
 * ENGINE-SIDE and is the only caller — the test suite never sees it, and
 * nothing here can mint evidence: it only provisions the subjects and
 * actor identities a declared case may drive.
 *
 * The recipe `two-tenants-two-accounts` provisions two real accounts in
 * the running reference app through the app's OWN create route, then
 * returns their server-issued identities. Every case lease provisions
 * its own pair, so cases stay isolated from each other.
 *
 * The app is a loopback demo with no authentication, so an actor lease
 * carries an identity only; `resolveCredential` still resolves (the
 * engine refuses a declared `valid` credential it cannot resolve).
 */
import { randomUUID } from 'node:crypto';

const APP_BASE = (process.env.GATEFORGE_APP_BASE_URL ?? process.env.GATEFORGE_TARGET_BASE_URL ?? '').replace(
  /\/$/,
  '',
);
const ACTORS = {
  'owner-a': { principalId: 'owner-a', tenantId: 'tenant-a', roles: ['owner'] },
  'admin-a': { principalId: 'admin-a', tenantId: 'tenant-a', roles: ['admin'] },
};
const live = new Map();
let counter = 0;

/** The account id the app's create route reports back. */
function createdId(body) {
  const ids = Array.isArray(body.created) ? body.created : Array.isArray(body.accounts) ? body.accounts : [];
  const id = ids.length > 0 ? ids[ids.length - 1] : body.id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('the app created no account id');
  return id;
}

/** Creates one account through the app's own bulk-import route. */
async function createAccount(firstName, lastName) {
  const response = await fetch(`${APP_BASE}/imports/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ rows: [{ first_name: firstName, last_name: lastName }] }),
  });
  if (!response.ok) throw new Error(`fixture provisioning failed: HTTP ${response.status}`);
  return createdId(await response.json());
}

/** Reads one provisioned account back so the identity is server-issued. */
async function readAccount(id) {
  const response = await fetch(`${APP_BASE}/api/accounts/${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json' },
  });
  if (response.status !== 200) throw new Error(`provisioned account ${id} is not readable`);
  return response.json();
}

export default {
  async prepare(input) {
    if (APP_BASE === '') {
      throw new Error(
        'GATEFORGE_APP_BASE_URL (or GATEFORGE_TARGET_BASE_URL) is required to provision the reference app',
      );
    }
    counter += 1;
    const leaseId = randomUUID();
    const suffix = `${String(counter)}-${leaseId.slice(0, 8)}`;
    const accountA = await readAccount(await createAccount('Ada', `Lovelace-${suffix}`));
    const accountB = await readAccount(await createAccount('Grace', `Hopper-${suffix}`));
    const actors = {};
    for (const [name, template] of Object.entries(ACTORS)) {
      actors[name] = { ...template, roles: [...template.roles], credentialRef: `credref:${leaseId}:${name}` };
    }
    const subjects = {
      accountA: { id: accountA.id, identity: accountA.id },
      accountB: { id: accountB.id, identity: accountB.id },
    };
    live.set(leaseId, subjects);
    return {
      leaseId,
      namespace: `fixture-${input.runId}-${input.caseId}-${String(counter)}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-'),
      subjects,
      actors,
    };
  },
  release(leaseId) {
    live.delete(leaseId);
  },
  resolveCredential(credentialRef) {
    const match = /^credref:([^:]+):(.+)$/.exec(credentialRef);
    if (match === null || !live.has(match[1])) return null;
    // The reference app is unauthenticated: the actor's identity IS its
    // authority, and the engine still requires the material to resolve.
    return { headers: {} };
  },
};
