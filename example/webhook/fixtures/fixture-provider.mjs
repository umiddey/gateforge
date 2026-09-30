/**
 * The operator-provided trusted fixture/actor provider
 * (`GATEFORGE_FIXTURE_PROVIDER`).
 *
 * The engine loads this module; the suite never sees it. It provisions
 * the recipe declared in `webhook-fixtures.yml` — the raw JSON body the
 * engine signs and posts, and the shared secret the receiver verifies it
 * with. The secret is generated per run by `npm run gate` and handed to
 * both the app and this provider through the environment, so no key
 * material is ever committed to the repository.
 */
import { randomUUID } from 'node:crypto';

const RECIPIENT_SECRET = process.env['WEBHOOK_SECRET'];
if (RECIPIENT_SECRET === undefined || RECIPIENT_SECRET.length === 0) {
  throw new Error('WEBHOOK_SECRET must name the shared signing secret of the receiver');
}
const ACTORS = { provider: { principalId: 'provider', tenantId: null, roles: [] } };
const SUBJECTS = {
  'stripe-delivery': {
    'accepted-event': JSON.stringify({ event_id: 'evt-accepted', type: 'payment.completed' }),
  },
};
const live = new Map();
let counter = 0;

export default {
  prepare(input) {
    counter += 1;
    const leaseId = randomUUID();
    const actors = {};
    for (const [name, template] of Object.entries(ACTORS)) {
      actors[name] = { ...template, roles: [...template.roles], credentialRef: `credref:${leaseId}:${name}` };
    }
    const subjects = SUBJECTS[input.recipe] ?? {};
    live.set(leaseId, { subjects });
    return {
      leaseId,
      namespace: `fixture-${input.runId}-${input.caseId}-${String(counter)}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-'),
      subjects: JSON.parse(JSON.stringify(subjects)),
      actors,
    };
  },
  release(leaseId) {
    live.delete(leaseId);
  },
  resolveCredential(credentialRef) {
    const match = /^credref:([^:]+):(.+)$/.exec(credentialRef);
    if (match === null || !live.has(match[1])) return null;
    return { headers: { 'x-gateforge-signing-secret': RECIPIENT_SECRET } };
  },
};
