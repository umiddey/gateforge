// A complete, self-contained overlay proof test. Copy it into your own
// `tests/e2e/gateforge/<resource>.<op>.spec.js` and change the surface —
// the fixture calls never change.
//
// The shape is always the same:
//
//   1. `gateforgeTest.extend({ surface })` — YOUR half: the selectors
//      that read YOUR rendered UI. The pack ships no selectors.
//   2. `annotation: { type: 'gateforge', description: '<obligation key>' }`
//      — the claim this test proves. Copy the exact key from
//      `gateforge next` or the report; a test that names no obligation
//      grades nothing.
//   3. `evidence.ui.*` — the UI action, inside a witness-recorded
//      interval, with the created identity read back from the rendered
//      list (never from suite-declared data).
//   4. `evidence.visible.confirm(receipt)` — the result a user sees.
//   5. `evidence.http.observe(...)` — the transport exchange the browser
//      made inside that same interval.
//   6. `evidence.persistence.verify(receipt)` — the engine observes the
//      server's own echo on the SAME entity; `fieldsMatch` is the
//      postcondition, graded by the engine, not by this test.
//   7. `evidence.finalize()` — closes the evidence bundle.
//
// Every `evidence` call is a witnessed channel. A plain `page.click` is
// not evidence: nothing then proves what the server stored.
import { test as gateforgeTest, expect, SURFACE_DESCRIPTOR_VERSION } from '@gate-forge/pack-playwright';

// Replace these selectors with your own rendered UI. Every section is
// required (`validateSurface` refuses an incomplete surface); `{id}`
// templates are substituted with the entity id the UI action produced.
const surface = Object.freeze({
  schemaVersion: SURFACE_DESCRIPTOR_VERSION,
  list: {
    path: '/',
    readySelector: 'h1:has-text("Contacts")',
    rowSelector: 'tbody tr',
    idCellIndex: 0,
    fieldCellIndexes: { name: 1, status: 2 },
  },
  create: {
    formPath: '/contacts/new',
    formReadySelector: 'form[action="/contacts"]',
    fields: { name: 'input[name="name"]' },
    submitSelector: 'button[type="submit"]',
  },
  edit: {
    linkSelector: 'a[href$="/edit"]',
    formReadySelectorTemplate: 'form[action="/contacts/{id}"]',
    fields: { name: 'input[name="name"]' },
    saveSelectorTemplate: 'form[action="/contacts/{id}"] button:not([formaction])',
  },
  archive: {
    controlSelectorTemplate: 'form[action="/contacts/{id}/archive"] button',
  },
  status: {
    field: 'status',
    createdValue: 'active',
    archivedValue: 'archived',
  },
  afterAction: { path: '/' },
  deleteFields: { status: 'archived' },
});

const test = gateforgeTest.extend({ surface });

test('creates a contact through the rendered UI (persistence:create)', {
  annotation: { type: 'gateforge', description: 'tenant.contacts:persistence:create' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.create({ fields: { name: 'Ada' } });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/contacts' });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});
