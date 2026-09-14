// Consumer-owned surface descriptor for the Gateforge example app
// (plan Phase 1 item 7): the APPLICATION-SPECIFIC half of the evidence
// fixture. The pack ships no selectors — the consumer declares how its
// rendered UI is observed (list page, rows and field cells, form
// templates, archive control, status values) and extends the gateforge
// runner with it:
//
//   import { test as gateforgeTest, expect } from '@gateforge/pack-playwright';
//   import { accountsSurface } from './accounts-surface.js';
//   const test = gateforgeTest.extend({ surface: accountsSurface });
//
// `{id}` templates are substituted with the entity id the UI action
// produced (observed from the rendered list, never suite-declared).
import { SURFACE_DESCRIPTOR_VERSION } from '@gateforge/pack-playwright';

export const accountsSurface = Object.freeze({
  schemaVersion: SURFACE_DESCRIPTOR_VERSION,
  list: {
    path: '/',
    readySelector: 'h1:has-text("Accounts")',
    rowSelector: 'tbody tr',
    idCellIndex: 0,
    fieldCellIndexes: { first_name: 1, last_name: 2, status: 3 },
  },
  create: {
    formPath: '/accounts/new',
    formReadySelector: 'form[action="/accounts"]',
    fields: {
      first_name: 'input[name="first_name"]',
      last_name: 'input[name="last_name"]',
    },
    submitSelector: 'button[type="submit"]',
  },
  edit: {
    linkSelector: 'a[href$="/edit"]',
    formReadySelectorTemplate: 'form[action="/accounts/{id}"]',
    fields: {
      first_name: 'input[name="first_name"]',
      last_name: 'input[name="last_name"]',
    },
    // The edit page renders TWO submit controls (save + archive); the
    // save control is the submit button that carries no formaction.
    saveSelectorTemplate: 'form[action="/accounts/{id}"] button:not([formaction])',
  },
  archive: {
    controlSelectorTemplate: 'form[action="/accounts/{id}/archive"] button',
  },
  status: {
    field: 'status',
    createdValue: 'active',
    archivedValue: 'archived',
  },
  afterAction: {
    // Every successful mutation answers 303 → "/" so the rendered list
    // is the visible result of the action.
    path: '/',
  },
  deleteFields: { status: 'archived' },
});
