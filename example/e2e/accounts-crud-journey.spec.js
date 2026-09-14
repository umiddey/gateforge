// Example journey proving a real browser flow through the strict gate
// (plan Phase 1 item 4). The journey declares intent only — the ENGINE
// drives its own Chromium through the rendered app, observes the action,
// the application request, and the visible result itself, and issues
// engine-observed records. The engine independently grades the
// engine-captured session exchange, the engine-read visible result, and
// the engine-observed persistence echo on the SAME entity.
//
// The claim names the obligation the journey proves
// (`tenant.accounts:persistence:create` — the engine-observed
// persistence postcondition). For UI-semantic `crud:*` claims, swap the
// annotation to the crud contract: the same engine-observed bundle
// satisfies it (see the ENGINE-BROWSER proof in e2e-example.test.ts).
//
//   import { accountsSurface } from './accounts-surface.js';   // consumer-owned selectors
//   const test = gateforgeTest.extend({ surface: accountsSurface });
import { test as gateforgeTest, expect } from '@gateforge/pack-playwright';
import { accountsSurface } from './accounts-surface.js';

const test = gateforgeTest.extend({ surface: accountsSurface });

test('creates an account through the rendered UI (persistence:create)', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:persistence:create' },
}, async ({ evidence }) => {
  // The UI action: fill the rendered form, submit, read the created
  // identity from the list. Runs inside a witness-recorded interval.
  const receipt = await evidence.ui.create({ fields: { first_name: 'Ada', last_name: 'Lovelace' } });
  // The visible result read back from the rendered row.
  await evidence.visible.confirm(receipt);
  // The witnessed transport exchange: consumes the browser's form POST
  // observed through this session's channel inside the action interval.
  await evidence.http.observe({ method: 'POST', path: '/accounts' });
  // The engine-observed persistence echo on the SAME entity.
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});
