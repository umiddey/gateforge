// Consumer-owned WIZARD surface descriptor (surface v2, Phase 3):
// map-authoring example for a multi-screen create flow the legacy
// single-form shape cannot drive — a vendor-contract creation wizard
// (draft orb → type picker → scope radio → supplier fill → submit).
//
// The engine walks `create.steps` ITSELF on its own page; the test only
// declares input fields. Steps are locators plus field references —
// never proof: a wrong selector fails closed (elements never match).
// Custom searchable dropdowns, drag-and-drop, file pickers, and hover
// menus are NOT expressible — those flows stay on the Observe channel
// (`--kind observed-e2e`), never squeezed into steps.
//
//   import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
//   import { vendorWizardSurface } from './vendor-wizard-surface.js';
//   const test = gateforgeTest.extend({ surface: vendorWizardSurface });
//
//   test('creates a vendor contract', {
//     annotation: { type: 'gateforge', description: 'tenant.vendor_contracts:persistence:create' },
//   }, async ({ evidence }) => {
//     const receipt = await evidence.ui.create({ fields: { supplier_name: 'Acme' } });
//     await evidence.visible.confirm(receipt);
//     const outcome = await evidence.persistence.verify(receipt);
//     expect(outcome.verdictRelevant.fieldsMatch).toBe(true);
//     await evidence.finalize();
//   });
import { SURFACE_DESCRIPTOR_VERSION } from '@gate-forge/pack-playwright';

export const vendorWizardSurface = Object.freeze({
  schemaVersion: SURFACE_DESCRIPTOR_VERSION,
  list: {
    path: '/contracts',
    readySelector: 'h1:has-text("Contracts")',
    rowSelector: 'tbody tr',
    idCellIndex: 0,
    fieldCellIndexes: { supplier_name: 1, status: 2 },
  },
  create: {
    // Declared input vocabulary (echo source). Selectors live in steps.
    fields: {
      supplier_name: 'text',
      delivery_terms: 'text',
    },
    steps: [
      { goto: '/contracts' },
      { click: '[data-testid="draft-orb"]' },
      { click: '[data-testid="draft-orb-create-rental_contract"]' },
      { click: 'text=Vendor' },
      { check: 'input[name="scopeType"][value="building"]' },
      { fill: { selector: 'input[placeholder*="Supplier"]', field: 'supplier_name' } },
      { fill: { selector: 'input[placeholder*="delivery"]', value: 'FOB Berlin' } },
      { waitFor: '[data-testid="record-sheet-primary"]' },
      { click: '[data-testid="record-sheet-primary"]' },
    ],
  },
  edit: {
    linkSelector: 'a[href$="/edit"]',
    formReadySelectorTemplate: 'form[action="/contracts/{id}"]',
    fields: {
      supplier_name: 'input[name="supplier_name"]',
    },
    saveSelectorTemplate: 'form[action="/contracts/{id}"] button:not([formaction])',
  },
  archive: {
    controlSelectorTemplate: 'form[action="/contracts/{id}/archive"] button',
  },
  status: {
    field: 'status',
    createdValue: 'active',
    archivedValue: 'archived',
  },
  afterAction: {
    path: '/contracts',
  },
  deleteFields: { status: 'archived' },
});
